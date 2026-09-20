# Design Note: Making the Price Scraper Reliable

## 1. Problem

The catalog is straightforward; the product price is not.

The INE mock store deliberately makes the price difficult to read reliably. A naive scraper can see the wrong number, miss the price entirely, or save a transient value as if it were final.

The main behaviors I observed during headed runs and diagnostic probing were:

- **Hover-gated reveal:** the **Reveal price** button stays disabled until there is real pointer movement and a short dwell over the price area.
- **Asynchronous request chain:** clicking Reveal can trigger `/api/challenge`, `POST /api/session`, and `/api/products/:id/price`, with transient `429`, `500`, or `503` responses.
- **Misleading DOM:** the price area can contain hidden decoys, a struck-through MRP, the sale price, a discount label, and a faded provisional value while the page is still updating.
- **Rotating layout classes:** CSS class names are not treated as stable identifiers.
- **Cookie-consent overlay:** a consent dialog can cover the page and interfere with pointer interaction.

The design goal is therefore not "scrape something that looks like a price." It is:

> **Only persist a price when the scraper has enough evidence that the rendered value is the correct, settled value for that attempt.**

## 2. Access strategy: use the lightest correct tool

I deliberately use two different access patterns.

### Catalog: HTTP

The catalog is exposed as JSON, so a browser adds cost without adding correctness.

Catalog search therefore uses:

- normal HTTP requests
- sequential page traversal
- retry handling
- `Retry-After` support
- short in-memory page caching
- de-duplication across pages

For a search query, the backend scans the catalog rather than assuming the first page contains the requested product.

### Product price/stock: Playwright

The product page genuinely needs browser behavior:

- trusted pointer movement
- hover-gated reveal
- page JavaScript
- asynchronous state changes

Using plain `fetch()` for the product page would not reproduce that behavior reliably.

I also deliberately **do not decode the opaque price payload** returned by the store. The page already knows how to render it, so the scraper reads the rendered result after the store reports success. This reduces coupling to an internal payload format.

## 3. Reliability strategy

| Failure mode                          | Defensive behavior                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Reveal disabled until hover           | Deterministic pointer path with 12 moves, 40 ms gaps and a 700 ms dwell; up to 3 sweeps                              |
| Cookie overlay present                | Attempt to dismiss the consent action before interacting with the price block                                        |
| Click has no visible effect           | Verify network/state activity after the click; retry with a fresh hover                                              |
| Slow or failing request chain         | Wait for the store's `price-success` / `price-error` state instead of relying on a fixed sleep                       |
| Provisional price                     | Require no visible "Updating…" state, sufficient opacity, and price stability before accepting                       |
| Multiple price candidates             | Select by semantics: visible, not `aria-hidden`, not struck through; ambiguous structure becomes `STRUCTURE_CHANGED` |
| Discount label lags                   | Compare the implied discount from price/MRP to the displayed discount and keep waiting when inconsistent             |
| Browser/page state becomes unreliable | Fresh Playwright context for every attempt                                                                           |
| Repeated failure                      | Exponential backoff between attempts (`3s`, `6s`, then `12s`)                                                        |
| Free-tier backend sleep               | External cron-job.org triggers `POST /api/scrape/run` every 2 hours                                                  |
| Overlapping scheduled runs            | In-memory scheduled-run guard rejects a second concurrent trigger within the same running instance                   |

## 4. How correctness is protected

The most important invariant is:

> **A failed scrape must never become a successful history point.**

The pipeline is:

```text
Load page
   ↓
Hover / Reveal
   ↓
Store success state
   ↓
Wait for settled value
   ↓
Semantic price selection
   ↓
Price + MRP + discount validation
   ↓
Stock validation
   ↓
ONLY NOW → price_history
```

For every attempt, `scrape_logs` records whether it was:

- `success`
- `retried`
- `failed`

A failed attempt therefore remains observable even though it does not create a misleading history point.

This makes chart gaps meaningful: a missing point means the system could not establish a trustworthy reading, not that it silently invented one.

## 5. Price-selection rules

The scraper does not take the first `₹...` value it finds.

Inside the price block it:

1. ignores hidden elements;
2. ignores `aria-hidden` elements;
3. identifies struck-through values as MRP;
4. requires exactly one visible, non-struck candidate as the sale price;
5. rejects ambiguous structures as `STRUCTURE_CHANGED`.

It also checks that:

```text
sale price <= MRP
```

and, when a discount label is present, that the implied discount is within one percentage point of the displayed discount.

This matters because a provisional value can look perfectly valid as a number while still contradicting the rest of the price block.

## 6. Provisional-price protection

One of the most important observations from the live store was that the page can enter a `price-success` state before the displayed number is actually final.

Therefore `price-success` is only an intermediate signal.

The scraper waits until:

- `"Updating…"` is gone;
- the selected sale price is sufficiently opaque;
- the value remains unchanged for a stability window.

Only then does it validate and persist the reading.

## 7. Retry and failure model

A scrape uses up to three attempts by default.

Each attempt gets:

- a fresh browser context;
- its own timeout;
- its own log entry.

Backoff increases exponentially:

```text
Attempt 1 fails → wait 3s
Attempt 2 fails → wait 6s
Attempt 3 fails → final failure
```

This is intentionally sequential. Parallelizing many browser instances would increase memory usage on the free Render instance and can create unnecessary pressure on a store that is already returning rate limits.

## 8. Scheduling on the free tier

The application does not depend on an always-running `setInterval()` loop.

Instead:

```text
cron-job.org
    │
    │ every 2 hours
    ▼
POST /api/scrape/run
    │
    ├── return 202 immediately
    │
    └── scrape active products in the background
             │
             ├── price_history
             └── scrape_logs
```

This is important because the Render free instance can sleep.

The scheduled endpoint therefore acts as a trigger, while the scraper itself performs the expensive Playwright work after the HTTP response has been accepted.

## 9. Database integrity

Three tables represent the tracking lifecycle:

- `tracked_products` — what is currently being tracked;
- `price_history` — only validated price/stock observations;
- `scrape_logs` — every attempt, including failures.

Untracking is implemented as a soft deactivation (`active = false`) so previous history and logs are retained.

This means a product can be removed from the active tracking list without destroying the evidence of what happened while it was tracked.

## 10. Bonus features

The implementation adds a few small features that build directly on the core data model rather than introducing unrelated complexity.

### Price-drop indicator

The frontend compares the newest two successful `price_history` rows and shows the absolute and percentage drop when the price decreases.

### Back-in-stock indicator

The frontend compares the newest two stock states and flags a transition from an unavailable status to an available status.

### Structure-change protection

When the expected semantic price structure is missing or ambiguous, the scraper explicitly reports `STRUCTURE_CHANGED` and refuses to persist a guessed value.

## 11. Trade-offs

### Playwright instead of HTTP for the price

More CPU, memory and latency, but it is necessary because the price is genuinely browser-driven.

### DOM reading instead of decoding the opaque payload

This is less coupled to the store's internal encoding, at the cost of depending on stable semantic structure.

### Validation over completeness

A missing point is preferable to a wrong point. The system intentionally fails closed.

### Sequential browser usage

Slower than parallel scraping, but better suited to a free 512 MB-class instance and gentler on the store's rate limits.

### Background scheduled execution

The scheduled endpoint returns `202` quickly so the external scheduler does not wait for Playwright. The trade-off is that a scheduled scrape's final result is observed through Render logs and the application's persisted scrape history/logs, not in the original HTTP response.

## 12. What the AI tools got wrong initially

I used AI assistance during investigation and implementation, but the first versions made several important mistakes.

1. **It clicked Reveal immediately.** The first implementation relied too heavily on element waiting. A headed probe showed that the button remained disabled until real pointer movement and dwell. I replaced the naive click with deterministic pointer interaction.

2. **It selected the wrong currency value.** The first parser could take the struck-through MRP because it was simply the first `₹` amount. I changed the selection rule to use visibility, `aria-hidden`, and line-through semantics.

3. **It accepted a provisional price.** The page could display a faded value while still updating. I added explicit settlement and discount-consistency checks before persistence.

4. **It misdiagnosed failures as rate limiting.** Several logs contained `429`s, but screenshots showed that a cookie-consent overlay was also blocking pointer interaction. The scraper therefore treats pointer accessibility as a separate failure mode.

5. **It used a weaker retry/data model.** Earlier logic could log success before the database write completed and reused browser state across retries. The current flow writes history only after validation and gives each attempt a fresh context.

6. **It searched only the first catalog page.** That made partial-name search incomplete. The current catalog search walks pages sequentially, caches pages briefly, and de-duplicates products before filtering.

These corrections are the main reason the final design emphasizes evidence and validation instead of optimistic parsing.

## 13. Verification and limits

The strongest verification was performed against the real hosted mock store in headed and repeated scraper runs.

Observed production behavior included:

- successful first attempts;
- retries after hover-gate failures;
- successful recovery on a later attempt;
- stored price/stock history only after a successful validated scrape;
- scrape logs containing both retry and success outcomes;
- scheduled cron trigger returning `202 Accepted`.

For example, a real run can legitimately show:

```text
#2  RETRY  [HOVER_GATE] ...
#3  OK     ₹16,943 / stock "Selling fast – 18 left..."
```

That is not considered a hidden failure; it is evidence that the retry path is functioning.

### Known limits

- The mock store can still fail or rate-limit unpredictably.
- The scraper intentionally fails closed when the page structure cannot be trusted.
- Scraping remains sequential.
- Some assumptions are store-specific, such as rupee-formatted prices and the current consent control.

The implementation prefers an honest failed attempt over a plausible but incorrect value.
