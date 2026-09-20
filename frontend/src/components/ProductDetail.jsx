import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid
} from "recharts";
import { getHistory, getLogs, scrapeNow } from "../lib/api.js";

function formatPrice(price) {
  if (price == null) return "—";
  return `₹${Number(price).toLocaleString("en-IN")}`;
}

// Stock is stored as free text ("Only 186 left", "In stock", "Out of
// stock") rather than a number, so pull a plottable quantity back out of
// it — same pattern the scraper itself uses when it first extracts it
// (see validateScrapedData in scrape.controller.js). Explicit "out of
// stock" wording maps to 0 rather than being dropped, since that's a real,
// chartable data point, not missing data.
function parseStockQty(stockStatus) {
  if (!stockStatus) return null;
  if (/out of stock|sold out|unavailable/i.test(stockStatus)) return 0;
  const match = /\d[\d,]*/.exec(stockStatus);
  return match ? Number(match[0].replace(/,/g, "")) : null;
}

function formatTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

const STATUS_LABEL = {
  success: "OK",
  retried: "RETRY",
  failed: "FAIL"
};

export default function ProductDetail({ product }) {
  const [history, setHistory] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [expandedLogId, setExpandedLogId] = useState(null);

  async function loadAll() {
    setLoading(true);
    const [h, l] = await Promise.all([getHistory(product.id), getLogs(product.id)]);
    setHistory(h);
    setLogs(l);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  async function handleScrape() {
    setScraping(true);
    try {
      await scrapeNow(product.id);
    } finally {
      await loadAll();
      setScraping(false);
    }
  }

  const chartData = [...history]
    .reverse()
    .map((row) => ({
      time: formatTime(row.scraped_at),
      price: Number(row.price),
      stock: parseStockQty(row.stock_status),
      stockLabel: row.stock_status || "—"
    }));

  // Only draw the stock line/axis when at least one point actually has a
  // parseable quantity — an all-null stock series would render as an empty
  // line sitting on the axis, which looks broken rather than "no data yet".
  const hasStockData = chartData.some((row) => row.stock != null);

  return (
    <section className="panel detail-panel">
      <div className="panel-head detail-head">
        <div>
          <h2>{product.product_name}</h2>
          <a href={product.product_url} target="_blank" rel="noreferrer" className="muted small">
            {product.product_url}
          </a>
        </div>
        <button type="button" className="btn btn-accent" disabled={scraping} onClick={handleScrape}>
          {scraping ? "Scraping…" : "Scrape now"}
        </button>
      </div>

      {loading ? (
        <p className="muted">Loading history…</p>
      ) : (
        <>
          <div className="chart-block">
            {chartData.length === 0 ? (
              <div className="empty-state">
                <p>No successful scrapes yet.</p>
                <p className="muted">Run a scrape to start building price history.</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={chartData} margin={{ top: 8, right: hasStockData ? 12 : 12, bottom: 0, left: -12 }}>
                  <CartesianGrid stroke="#e8e2d2" vertical={false} />
                  <XAxis dataKey="time" tick={{ fontSize: 11, fill: "#5b5a52" }} tickLine={false} />
                  <YAxis
                    yAxisId="price"
                    tick={{ fontSize: 11, fill: "#5b5a52" }}
                    tickLine={false}
                    width={64}
                    tickFormatter={(v) => `₹${v.toLocaleString("en-IN")}`}
                  />
                  {hasStockData && (
                    <YAxis
                      yAxisId="stock"
                      orientation="right"
                      tick={{ fontSize: 11, fill: "#5b5a52" }}
                      tickLine={false}
                      width={48}
                      allowDecimals={false}
                    />
                  )}
                  <Tooltip
                    formatter={(value, name, item) => {
                      if (item.dataKey === "price") return [`₹${value.toLocaleString("en-IN")}`, "Price"];
                      if (item.dataKey === "stock") return [item.payload.stockLabel, "Stock"];
                      return [value, name];
                    }}
                    contentStyle={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      border: "1px solid var(--line)",
                      borderRadius: 4
                    }}
                  />
                  {hasStockData && <Legend wrapperStyle={{ fontSize: 12 }} />}
                  <Line
                    yAxisId="price"
                    type="monotone"
                    dataKey="price"
                    name="Price"
                    stroke="#c2811e"
                    strokeWidth={2}
                    dot={{ r: 3, fill: "#c2811e" }}
                    connectNulls
                  />
                  {hasStockData && (
                    <Line
                      yAxisId="stock"
                      type="monotone"
                      dataKey="stock"
                      name="Stock"
                      stroke="#3f7d5c"
                      strokeWidth={2}
                      strokeDasharray="4 3"
                      dot={{ r: 3, fill: "#3f7d5c" }}
                      connectNulls={false}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            )}
            {chartData.length > 0 && !hasStockData && (
              <p className="muted small chart-note">
                Stock reported as text ("{chartData[chartData.length - 1].stockLabel}") without a number yet —
                the stock line will appear once a scrape reports a quantity.
              </p>
            )}
          </div>

          <div className="ledger-block">
            <h3>Scrape log</h3>
            {logs.length === 0 ? (
              <p className="muted">No attempts logged yet.</p>
            ) : (
              <div className="ledger">
                <div className="ledger-row ledger-row--head">
                  <span>TIME</span>
                  <span>ATTEMPT</span>
                  <span>STATUS</span>
                  <span>PRICE</span>
                  <span>DETAIL</span>
                </div>
                {logs.map((log) => {
                  const detail = log.error || log.message || "—";
                  const isExpanded = expandedLogId === log.id;
                  return (
                    <div
                      key={log.id}
                      className={`ledger-row ledger-row--${log.status}${isExpanded ? " ledger-row--expanded" : ""}`}
                      onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                      role="button"
                      tabIndex={0}
                    >
                      <span>{formatTime(log.started_at)}</span>
                      <span>#{log.attempt}</span>
                      <span className={`status-tag status-tag--${log.status}`}>
                        {STATUS_LABEL[log.status] || log.status}
                      </span>
                      <span>{formatPrice(log.price)}</span>
                      <span
                        className={`ledger-detail${isExpanded ? " ledger-detail--expanded" : ""}`}
                        title={isExpanded ? "" : detail}
                      >
                        {detail}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
