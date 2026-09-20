import { Router } from "express";
import { searchProductsController, getProductController } from "../controllers/products.controller.js";

const router = Router();

router.get("/api/products/search", searchProductsController);
router.get("/api/products/:id", getProductController);

export default router;
