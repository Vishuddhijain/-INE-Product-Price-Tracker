import { Router } from "express";
import {
  listTrackedProductsController,
  createTrackedProductController,
  getTrackedProductHistoryController,
  getTrackedProductLogsController,
  scrapeTrackedProductController,
  untrackProductController
} from "../controllers/tracking.controller.js";

const router = Router();

router.get("/api/tracked-products", listTrackedProductsController);
router.post("/api/tracked-products", createTrackedProductController);
router.get("/api/tracked-products/:id/history", getTrackedProductHistoryController);
router.get("/api/tracked-products/:id/logs", getTrackedProductLogsController);
router.post("/api/tracked-products/:id/scrape", scrapeTrackedProductController);
router.delete("/api/tracked-products/:id", untrackProductController);

export default router;
