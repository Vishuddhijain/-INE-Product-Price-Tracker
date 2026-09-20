import { scrapeAllTrackedProducts } from "../services/scraper.service.js";
import { listActiveTrackedProducts } from "../services/product.service.js";

let scheduledRunActive = false;

/**
 * Called by cron-job.org every 2 hours.
 * Starts the scheduled scrape and responds immediately.
 */
export async function runScheduledScrapeController(req, res, next) {
  try {
    if (scheduledRunActive) {
      return res.status(202).json({
        success: true,
        accepted: true,
        message: "A scheduled scrape is already running.",
      });
    }

    scheduledRunActive = true;

    // Respond immediately so the external cron service does not wait
    // for the Playwright scraping to finish.
    res.status(202).json({
      success: true,
      accepted: true,
      message: "Scheduled scrape started.",
    });

    // Run scraping in the background.
    try {
      const trackedProducts = await listActiveTrackedProducts();

      if (trackedProducts.length === 0) {
        console.log("[scheduler] No active tracked products.");
        return;
      }

      const results = await scrapeAllTrackedProducts(
        trackedProducts,
        { headed: false }
      );

      console.log(
        `[scheduler] Completed scheduled scrape for ${results.length} product(s).`
      );
    } catch (error) {
      console.error(
        "[scheduler] Background scrape failed:",
        error
      );
    } finally {
      scheduledRunActive = false;
    }
  } catch (error) {
    next(error);
  }
}