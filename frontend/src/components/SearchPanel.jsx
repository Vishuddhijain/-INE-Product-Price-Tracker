import { useState } from "react";
import { searchProducts, trackProduct, untrackProduct } from "../lib/api.js";

export default function SearchPanel({ trackedByUrl, onTracked, onUntracked }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [pendingUrl, setPendingUrl] = useState(null);
  const [error, setError] = useState("");

  async function runSearch(e) {
    e.preventDefault();
    if (!query.trim()) return;
    setStatus("loading");
    setError("");
    try {
      const data = await searchProducts(query.trim());
      setItems(data.items || []);
      setStatus("done");
    } catch (err) {
      setError(err?.response?.data?.error || err.message || "Search failed.");
      setStatus("error");
    }
  }

  async function handleTrack(item) {
    setPendingUrl(item.productUrl);
    try {
      const saved = await trackProduct({
        name: item.name,
        url: item.productUrl,
        imageUrl: item.imageUrl
      });
      onTracked(saved);
    } catch (err) {
      setError(err?.response?.data?.error || err.message || "Could not track this product.");
    } finally {
      setPendingUrl(null);
    }
  }

  async function handleUntrack(item, trackedId) {
    setPendingUrl(item.productUrl);
    try {
      await untrackProduct(trackedId);
      onUntracked?.(trackedId);
    } catch (err) {
      setError(err?.response?.data?.error || err.message || "Could not untrack this product.");
    } finally {
      setPendingUrl(null);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Find a product</h2>
        <p>Search the store, then track anything worth watching.</p>
      </div>

      <form className="search-row" onSubmit={runSearch}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name — “bottle”, “monitor”, “desk”…"
          aria-label="Search products"
        />
        <button type="submit" className="btn btn-accent">
          Search
        </button>
      </form>

      {error && <p className="error-text">{error}</p>}

      {status === "loading" && <p className="muted">Searching the catalog…</p>}

      {status === "done" && items.length === 0 && (
        <p className="muted">No products matched “{query}”. Try a different word.</p>
      )}

      {items.length > 0 && (
        <ul className="result-list">
          {items.map((item) => {
            const trackedId = trackedByUrl.get(item.productUrl);
            const isPending = pendingUrl === item.productUrl;

            return (
              <li key={item.productUrl} className="result-row">
                <div className="result-info">
                  <span className="result-name">{item.name}</span>
                  <span className="result-meta">
                    {item.brand && <span>{item.brand}</span>}
                    {item.sku && <span className="mono">{item.sku}</span>}
                  </span>
                </div>
                {trackedId ? (
                  <button
                    type="button"
                    className="btn btn-outline btn-untrack-outline"
                    disabled={isPending}
                    onClick={() => handleUntrack(item, trackedId)}
                  >
                    {isPending ? "Removing…" : "Untrack"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={isPending}
                    onClick={() => handleTrack(item)}
                  >
                    {isPending ? "Adding…" : "Track"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
