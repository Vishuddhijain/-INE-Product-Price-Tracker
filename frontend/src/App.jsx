import { useEffect, useMemo, useState } from "react";
import SearchPanel from "./components/SearchPanel.jsx";
import TrackedList from "./components/TrackedList.jsx";
import ProductDetail from "./components/ProductDetail.jsx";
import { listTrackedProducts } from "./lib/api.js";
import "./App.css";

export default function App() {
  const [tracked, setTracked] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loaded, setLoaded] = useState(false);

  async function refresh() {
    const items = await listTrackedProducts();
    setTracked(items);
    setLoaded(true);
  }

  useEffect(() => {
    refresh();
  }, []);

  const trackedUrls = useMemo(() => new Set(tracked.map((t) => t.product_url)), [tracked]);
  const selected = tracked.find((t) => t.id === selectedId) || null;

  function handleTracked(saved) {
    setTracked((prev) => [saved, ...prev]);
    setSelectedId(saved.id);
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="wordmark">
          <span className="wordmark-mark">▲</span>
          <span>Ledger</span>
        </div>
        <p className="tagline">A quiet way to watch prices move.</p>
      </header>

      <main className="layout">
        <div className="layout-left">
          <SearchPanel trackedUrls={trackedUrls} onTracked={handleTracked} />
          {loaded && (
            <TrackedList
              items={tracked}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onRefresh={refresh}
            />
          )}
        </div>

        <div className="layout-right">
          {selected ? (
            <ProductDetail product={selected} />
          ) : (
            <section className="panel detail-panel detail-panel--empty">
              <p className="muted">Select a tracked product to see its price history and scrape log.</p>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
