import { supabase } from "../lib/supabase.js";

/**
 * price_history columns: id, tracked_product_id (uuid), price (numeric),
 * stock_status (text), scraped_at (timestamptz, default now()).
 * DB enforces price NOT NULL and stock_status NOT NULL — never call this
 * with an invalid price/stock; validate before calling.
 */
export async function savePriceHistory({ trackedProductId, price, stockStatus }) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("price_history")
    .insert([
      {
        tracked_product_id: trackedProductId,
        price,
        stock_status: stockStatus
      }
    ])
    .select();

  if (error) {
    console.error("price_history insert failed:", error.message);
    throw error;
  }

  return data?.[0] || null;
}

export async function getProductHistory(trackedProductId) {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("price_history")
    .select("*")
    .eq("tracked_product_id", trackedProductId)
    .order("scraped_at", { ascending: false })
    .limit(200);

  if (error) {
    console.warn("Unable to fetch price history:", error.message);
    return [];
  }

  return data || [];
}

/**
 * scrape_logs columns: id, tracked_product_id (uuid), started_at, finished_at,
 * attempt (int, default 1), status (text), message, price, stock_status, error.
 * One row per attempt — a scrape that retries twice before succeeding writes
 * three rows (attempt 1/2 = 'retried' or 'failed', attempt 3 = 'success').
 */
export async function saveScrapeLog({
  trackedProductId,
  attempt = 1,
  status,
  message = null,
  price = null,
  stockStatus = null,
  error = null,
  startedAt,
  finishedAt
}) {
  if (!supabase) return null;

  const { data, error: dbError } = await supabase
    .from("scrape_logs")
    .insert([
      {
        tracked_product_id: trackedProductId,
        attempt,
        status,
        message,
        price,
        stock_status: stockStatus,
        error,
        started_at: startedAt,
        finished_at: finishedAt
      }
    ])
    .select();

  if (dbError) {
    console.error("scrape_logs insert failed:", dbError.message);
    return null;
  }

  return data?.[0] || null;
}

export async function getScrapeLogs(trackedProductId) {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("scrape_logs")
    .select("*")
    .eq("tracked_product_id", trackedProductId)
    .order("started_at", { ascending: false })
    .limit(200);

  if (error) {
    console.warn("Unable to fetch scrape logs:", error.message);
    return [];
  }

  return data || [];
}
