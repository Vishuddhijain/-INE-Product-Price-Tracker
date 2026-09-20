// Given the two most recent price_history rows (newest first), work out
// whether the price dropped and whether the product just came back in
// stock. Both are pure comparisons — no new data needed, price_history
// already has everything.

function isOutOfStock(stockStatus) {
  return Boolean(stockStatus) && /out of stock|sold out|unavailable/i.test(stockStatus);
}

export function getPriceDrop(current, previous) {
  if (!current || !previous) return null;
  const currentPrice = Number(current.price);
  const previousPrice = Number(previous.price);
  if (!Number.isFinite(currentPrice) || !Number.isFinite(previousPrice)) return null;
  if (currentPrice >= previousPrice) return null;

  const amount = previousPrice - currentPrice;
  const percent = (amount / previousPrice) * 100;
  return { amount, percent, previousPrice, currentPrice };
}

export function justBackInStock(current, previous) {
  if (!current || !previous) return false;
  return isOutOfStock(previous.stock_status) && !isOutOfStock(current.stock_status);
}
