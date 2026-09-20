import { z } from "zod";

export const productSearchSchema = z.object({
  q: z.string().trim().min(1).max(100).optional().default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});

// Matches tracked_products exactly: product_name + product_url are the only
// required fields (product_url is UNIQUE — that's the link back to the live
// catalog product, there is no numeric product_id column on this table).
export const trackTrackedProductSchema = z.object({
  name: z.string().trim().min(1).max(200),
  url: z.string().trim().url(),
  imageUrl: z.string().trim().url().optional().nullable()
});

export function createError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function parseTrackProductInput(input = {}) {
  return trackTrackedProductSchema.parse({
    name: input.name,
    url: input.url ?? input.productUrl,
    imageUrl: input.imageUrl ?? input.image_url ?? null
  });
}
