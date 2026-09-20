import { Router } from "express";
import { runScheduledScrapeController } from "../controllers/scrape.controller.js";

const router = Router();

// Called by the external cron service (cron-job.org) every 2 hours.
// Manual "Scrape Now" for a single product lives at
// POST /api/tracked-products/:id/scrape (tracking.routes.js).
router.post("/api/scrape/run", runScheduledScrapeController);

export default router;
