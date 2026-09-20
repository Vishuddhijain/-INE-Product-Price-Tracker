import { searchProducts, getProductById } from "../services/product.service.js";
import { productSearchSchema, createError } from "../utils/validation.js";

export async function searchProductsController(req, res, next) {
  try {
    const parsed = productSearchSchema.parse(req.query);
    const result = await searchProducts(parsed);
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
}

/** Live catalog lookup only — does NOT trigger a Playwright scrape. */
export async function getProductController(req, res, next) {
  try {
    const productId = Number(req.params.id || 0);
    if (!productId) {
      throw createError("Product ID is required.", 400);
    }

    const product = await getProductById(productId);
    res.json({ success: true, product });
  } catch (error) {
    next(error);
  }
}