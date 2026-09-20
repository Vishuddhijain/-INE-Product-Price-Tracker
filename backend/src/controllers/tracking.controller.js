import {
  createTrackedProduct,
  findTrackedProductById,
  listActiveTrackedProducts,
  untrackProduct
} from "../services/product.service.js";
import { getProductHistory, getScrapeLogs } from "../services/history.service.js";
import { scrapeTrackedProduct } from "../services/scraper.service.js";
import { parseTrackProductInput, createError } from "../utils/validation.js";

// tracked_products.id is a UUID string — never Number() it. Just check it's present.
function requireTrackedId(req) {
  const trackedId = req.params.id;
  if (!trackedId) {
    throw createError("Tracked product ID is required.", 400);
  }
  return trackedId;
}

export async function listTrackedProductsController(req, res, next) {
  try {
    const items = await listActiveTrackedProducts();
    res.json({ success: true, items });
  } catch (error) {
    next(error);
  }
}

export async function createTrackedProductController(req, res, next) {
  try {
    const input = parseTrackProductInput(req.body || {});
    const saved = await createTrackedProduct(input);
    res.status(201).json({ success: true, item: saved });
  } catch (error) {
    next(error);
  }
}

export async function getTrackedProductHistoryController(req, res, next) {
  try {
    const trackedId = requireTrackedId(req);
    const existing = await findTrackedProductById(trackedId);
    if (!existing) {
      throw createError("Tracked product not found.", 404);
    }

    const history = await getProductHistory(trackedId);
    res.json({ success: true, trackedProduct: existing, history });
  } catch (error) {
    next(error);
  }
}

export async function getTrackedProductLogsController(req, res, next) {
  try {
    const trackedId = requireTrackedId(req);
    const existing = await findTrackedProductById(trackedId);
    if (!existing) {
      throw createError("Tracked product not found.", 404);
    }

    const logs = await getScrapeLogs(trackedId);
    res.json({ success: true, trackedProduct: existing, logs });
  } catch (error) {
    next(error);
  }
}

export async function untrackProductController(req, res, next) {
  try {
    const trackedId = requireTrackedId(req);
    const existing = await findTrackedProductById(trackedId);
    if (!existing) {
      throw createError("Tracked product not found.", 404);
    }

    const updated = await untrackProduct(trackedId);
    res.json({ success: true, item: updated });
  } catch (error) {
    next(error);
  }
}

/** Manual "Scrape Now" for a single tracked product. */
export async function scrapeTrackedProductController(req, res, next) {
  try {
    const trackedId = requireTrackedId(req);
    const existing = await findTrackedProductById(trackedId);
    if (!existing) {
      throw createError("Tracked product not found.", 404);
    }

    const result = await scrapeTrackedProduct(existing);
    res.json({ success: result.success, item: existing, result });
  } catch (error) {
    next(error);
  }
}
