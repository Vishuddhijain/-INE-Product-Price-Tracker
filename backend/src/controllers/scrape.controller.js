import { scrapeAllTrackedProducts } from "../services/scraper.service.js";
import { listActiveTrackedProducts } from "../services/product.service.js";

/**
 * Hit by the external cron service (cron-job.org) every 2 hours.
 * Scrapes every active tracked product with one shared browser instance.
 */
export async function runScheduledScrapeController(req, res, next) {
  try {
    const trackedProducts = await listActiveTrackedProducts();

    if (trackedProducts.length === 0) {
      return res.json({ success: true, count: 0, items: [] });
    }

    const results = await scrapeAllTrackedProducts(trackedProducts, { headed: false });
    res.json({ success: true, count: results.length, items: results });
  } catch (error) {
    next(error);
  }
}