import { supabase } from "../lib/supabase.js";
import { withRetry, sleep } from "../utils/retry.js";
import { createError } from "../utils/validation.js";

const STORE_BASE_URL = process.env.STORE_BASE_URL || "https://demo.inelabteamdev.com";

function normalizeCatalogItem(item = {}) {
  const id = Number(item.id ?? item.product_id ?? 0);
  const slug = item.slug || "";
  const productUrl = `${STORE_BASE_URL}/product/${id || slug}`;

  return {
    id,
    slug,
    name: item.name || item.product_name || "",
    brand: item.brand || "",
    category: item.category || "",
    sku: item.sku || item.SKU || "",
    description: item.description || "",
    imageUrl: item.image || item.imageUrl || item.image_url || null,
    url: productUrl,
    productUrl
  };
}

const CATALOG_PAGE_SIZE = 50;
const MAX_CATALOG_PAGES = 20; // safety cap: 20 x 50 = up to 1000 products scanned
const CATALOG_CACHE_TTL_MS = Number(process.env.CATALOG_CACHE_TTL_MS) || 60000;

// Every search scans the whole catalog, so without caching, repeated
// searches hammer the live store and exhaust its rate limit fast. A short
// in-memory cache per page keeps normal usage well under that limit while
// still picking up real catalog changes within a minute.
const catalogPageCache = new Map(); // page -> { data, cachedAt }

async function fetchCatalogPage(page) {
  const cached = catalogPageCache.get(page);
  if (cached && Date.now() - cached.cachedAt < CATALOG_CACHE_TTL_MS) {
    return cached.data;
  }

  const catalogUrl = new URL(`${STORE_BASE_URL}/api/catalog`);
  catalogUrl.searchParams.set("page", String(page));
  catalogUrl.searchParams.set("pageSize", String(CATALOG_PAGE_SIZE));

  const data = await withRetry(
    async () => {
      const response = await fetch(catalogUrl.toString(), {
        headers: { Accept: "application/json" }
      });

      if (!response.ok) {
        const err = createError(`Catalog fetch failed (${response.status})`, response.status);
        const retryAfter = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterSeconds = retryAfter;
        throw err;
      }

      return response.json();
    },
    { retries: 3, label: `catalog page ${page}` }
  );

  catalogPageCache.set(page, { data, cachedAt: Date.now() });
  return data;
}

/**
 * Catalog search is a plain server-rendered JSON API — no browser needed.
 * A search query has to be able to match ANY product in the store, not just
 * whatever happens to be on page 1 — so when `q` is given, we walk every
 * catalog page (capped) and filter across the full result, not one page.
 */
export async function searchProducts({ q = "", page = 1, pageSize = 20 } = {}) {
  const query = (q || "").trim().toLowerCase();

  if (!query) {
    // No search term — just return one page of the live catalog as-is.
    const catalogData = await fetchCatalogPage(page);
    const items = Array.isArray(catalogData.items) ? catalogData.items : [];
    const normalizedItems = items.map(normalizeCatalogItem);
    
    return {
      page: Number(catalogData.page || page),
      pageSize: Number(catalogData.pageSize || CATALOG_PAGE_SIZE),
      total: Number(catalogData.total ?? normalizedItems.length),
      pages: Number(catalogData.pages || 1),
      items: normalizedItems
    };
  }

  // Search term given — scan every page of the real catalog.
  const firstPage = await fetchCatalogPage(1);
  const totalPages = Math.min(
    Number(firstPage.pages) || 1,
    MAX_CATALOG_PAGES
  );

  const allRawItems = Array.isArray(firstPage.items) ? [...firstPage.items] : [];

  // Sequential, not Promise.all — the catalog endpoint is itself rate-limited
  // (429), and firing every remaining page at once was tripping that limit
  // on the very first burst, before any individual page's own retry logic
  // even had a chance to help. A small gap between pages keeps us under it.
  for (let p = 2; p <= totalPages; p += 1) {
    const pageData = await fetchCatalogPage(p);
    if (Array.isArray(pageData.items)) allRawItems.push(...pageData.items);
    if (p < totalPages) await sleep(150);
  }

  const normalizedItems = allRawItems.map(normalizeCatalogItem);
    // The store's pagination overlaps in practice (its real page size doesn't
  // match what we requested), so the same product can appear on more than
  // one page. Dedupe by URL before filtering/returning — never surface the
  // same product twice.
  const seenUrls = new Set();
  const dedupedItems = normalizedItems.filter((item) => {
    if (seenUrls.has(item.productUrl)) return false;
    seenUrls.add(item.productUrl);
    return true;
  });
  const filteredItems = dedupedItems.filter((item) => {
    const haystack = [item.name, item.brand, item.sku]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });

  return {
    page: 1,
    pageSize: filteredItems.length,
    total: filteredItems.length,
    pages: 1,
    items: filteredItems
  };
}

/** Direct lookup — confirmed GET /api/product/:id exists, no need to page-scan the catalog. */
export async function getProductById(productId) {
  const id = Number(productId || 0);
  if (!id) {
    throw createError("Product ID is required.", 400);
  }

  const data = await withRetry(
    async () => {
      const response = await fetch(`${STORE_BASE_URL}/api/product/${id}`, {
        headers: { Accept: "application/json" }
      });

      if (response.status === 404) {
        throw createError(`Product ${id} was not found in the live catalog.`, 404);
      }
      if (!response.ok) {
        throw createError(`Product fetch failed (${response.status})`, response.status);
      }

      return response.json();
    },
    { retries: 3, label: "product lookup" }
  );

  return normalizeCatalogItem(data);
}

/**
 * tracked_products columns: id (uuid, generated), product_name, product_url
 * (unique, required), image_url, created_at, active. There is no numeric
 * product_id column here — product_url is the link back to the live catalog.
 */
export async function findTrackedProductById(trackedId) {
  if (!supabase || !trackedId) return null;

  const { data, error } = await supabase
    .from("tracked_products")
    .select("*")
    .eq("id", trackedId)
    .maybeSingle();

  if (error) {
    console.warn("Unable to fetch tracked product record:", error.message);
    return null;
  }

  return data;
}

export async function listActiveTrackedProducts() {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("tracked_products")
    .select("*")
    .eq("active", true)
    .order("created_at", { ascending: false });

  if (error) {
    console.warn("Unable to list tracked products:", error.message);
    return [];
  }

  return data || [];
}

export async function createTrackedProduct({ name, url, imageUrl } = {}) {
  if (!supabase) {
    throw createError("Supabase is not configured.", 503);
  }
  if (!name || !url) {
    throw createError("Both product name and product URL are required to track a product.", 400);
  }

  const { data, error } = await supabase
    .from("tracked_products")
    .insert([
      {
        product_name: name,
        product_url: url,
        image_url: imageUrl || null
      }
    ])
    .select();

  if (error) {
    // product_url is UNIQUE — a duplicate track attempt should read as a
    // clear 409, not a generic 500.
    if (/duplicate key|unique/i.test(error.message)) {
      throw createError("This product is already being tracked.", 409);
    }
    throw error;
  }

  return data?.[0] || null;
}