import { useEffect, useState } from "react";
import { getHistory, scrapeNow } from "../lib/api.js";

function formatPrice(price) {
  if (price == null) return "—";
  return `₹${Number(price).toLocaleString("en-IN")}`;
}

function timeAgo(iso) {
  if (!iso) return "never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function TrackedList({ items, selectedId, onSelect, onRefresh }) {
  const [latest, setLatest] = useState({});
  const [scrapingId, setScrapingId] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadLatest() {
      const entries = await Promise.all(
        items.map(async (item) => {
          try {
            const history = await getHistory(item.id);
            return [item.id, history[0] || null];
          } catch {
            return [item.id, null];
          }
        })
      );
      if (!cancelled) setLatest(Object.fromEntries(entries));
    }

    if (items.length > 0) loadLatest();
    return () => {
      cancelled = true;
    };
  }, [items]);

  async function handleScrape(item) {
    setScrapingId(item.id);
    try {
      await scrapeNow(item.id);
      const history = await getHistory(item.id);
      setLatest((prev) => ({ ...prev, [item.id]: history[0] || null }));
      onRefresh?.();
    } finally {
      setScrapingId(null);
    }
  }

  if (items.length === 0) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Tracked products</h2>
        </div>
        <div className="empty-state">
          <p>Nothing tracked yet.</p>
          <p className="muted">Search above and track a product to start watching its price.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Tracked products</h2>
        <p>Checked every 2 hours. Click a row for its full history and scrape log.</p>
      </div>

      <ul className="tracked-list">
        {items.map((item) => {
          const point = latest[item.id];
          const isActive = item.id === selectedId;
          const inStock = point?.stock_status && !/out of stock|sold out/i.test(point.stock_status);

          return (
            <li key={item.id}>
              <button
                type="button"
                className={`tracked-row${isActive ? " tracked-row--active" : ""}`}
                onClick={() => onSelect(item.id)}
              >
                <div className="tracked-main">
                  <span className="tracked-name">{item.product_name}</span>
                  <span className="tracked-sub">
                    Last checked {timeAgo(point?.scraped_at)}
                    {point?.stock_status ? ` · ${point.stock_status}` : ""}
                  </span>
                </div>
                <div className="tracked-price-block">
                  <span className={`price mono ${point ? "" : "price--empty"}`}>
                    {formatPrice(point?.price)}
                  </span>
                  {point && (
                    <span className={`stock-dot ${inStock ? "stock-dot--good" : "stock-dot--bad"}`} />
                  )}
                </div>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-scrape"
                disabled={scrapingId === item.id}
                onClick={() => handleScrape(item)}
              >
                {scrapingId === item.id ? "Scraping…" : "Scrape now"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
