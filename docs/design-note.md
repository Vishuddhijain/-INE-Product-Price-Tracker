# Design note: making the price scraper reliable

## What makes this store hard

The catalog is easy. The price is not: reading it takes an interaction, and the store is built to punish a naive scraper. I learned this from headed runs, three diagnostic scripts (`backend/scripts/probe-*.js`) and the HTML and screenshots the scraper saves when an attempt fails.

- **Hover-gated.** "Reveal price" stays disabled until real pointer movement plus a short dwell over the price block. The page says so itself: "Hover over the price area to load the current price."
- **A request chain behind the click.** `/api/challenge` (often 429, then 200), then `POST /api/session` (the solved challenge in, a 30-second token out), then `GET /api/products/:id/price`. That last response is `{productId, v, e, serverTime}` where `e` is an opaque base64 blob. The price endpoint itself returned 500 and 503 on some runs, and once the store gave up with "Couldn't load the price after 6 attempts (upstream 429)".
- **A DOM built to mislead.** The price block holds hidden decoy prices (`display:none`, `aria-hidden`), a struck-through MRP, the sale price, a "NN% off" label, and an "Updating…" state that shows a _provisional, faded_ price. I caught one at ₹59,210 beside a "45% off" label on a ₹92,195 item, when other runs of that product read ₹50,707. The discount label can also lag behind the price. Class names rotate with `/api/layout` (I saw variants `v2` and `v0`).
- **A cookie-consent modal** with a dimmed full-page overlay that swallows pointer events and clicks. I only found this by looking at screenshots: 7 of the 17 failure snapshots I saved showed the overlay, including all 5 where the price was still hidden.

## Approach

**Two access patterns.** Catalog search is plain HTTP against the store's JSON catalog: no browser, with page caching, de-duplication and retry that honours `Retry-After`. The price uses **Playwright**, because the gate needs trusted pointer events and the page's own JavaScript. I did not try to decode `e` or replay the challenge and session chain. That is the store's client logic, it is likely to change, and the page already renders the result. So I read the rendered DOM, and only after the store's own success state.

## What keeps it reliable

| What goes wrong                        | What the scraper does                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Button disabled until hover            | A fixed, non-random pointer path: 12 moves 40 ms apart across the price block, a 700 ms dwell, up to 3 sweeps.                                                                 |
| Consent modal blocks pointer and click | Dismissed before each sweep, while polling, before the click, and after an ineffective click. The number of dismissals is logged.                                              |
| Click silently ignored                 | After each click, verify something happened (a chain request, or the block leaving `price-idle`) within 5 s. If not, re-hover and click again, up to 3 times.                  |
| Slow or failing request chain          | Wait for the store's own `price-success` or `price-error` state (20 s), not a fixed sleep. Store errors and their status codes are recorded.                                   |
| Provisional price                      | Accepted only when "Updating…" is gone, the price is fully opaque, and the values are unchanged for 700 ms.                                                                    |
| Wrong number on the page               | The price is chosen by meaning, not position or class: visible, not `aria-hidden`, not struck through. Exactly one candidate, or the attempt fails as `STRUCTURE_CHANGED`.     |
| Price and label disagree               | The discount implied by price and MRP must match the "% off" label within one point. This is checked while waiting (so a lagging label is waited out) and again before saving. |
| Layout rotation                        | No hashed class names are used. The layout revision and variant are logged with every attempt.                                                                                 |
| Stale or crashed state                 | A fresh browser context per attempt, a hard per-attempt timeout, exponential backoff (3 s, then 6 s), and the browser is relaunched if it dies.                                |
| Free-tier sleep                        | An external cron job calls `POST /api/scrape/run`, which answers `202` at once and scrapes in the background, one run at a time. A second cron job keeps the instance warm.    |

## Honest data

`price_history` only receives a row after validation: a sane positive price, consistent with the MRP and discount label, and a visible stock badge. If the database write fails, the attempt counts as failed. Every attempt is exactly one `scrape_logs` row (`success`, `retried` or `failed`) carrying the error code, pointer moves, timings, and a compact network summary such as `challenge[429,429,200] session[200] price[500,503,200]`. A gap in the chart therefore always corresponds to something in the log, and never to a guess.

## Trade-offs

- **Playwright for the price** costs CPU, memory and seconds, but it is the only approach that returns a _correct_ price. HTTP stays for the catalog, where it is enough.
- **Reading the DOM, not decoding `e`.** Cheaper to maintain, but it depends on the page's markup, so I select by meaning and fail loudly when it doesn't fit.
- **Validation over completeness.** A doubtful reading is dropped and logged rather than saved, so the history has honest gaps.
- **Fail fast, then retry fresh.** Waiting 45 s for a stuck "Updating…" price did not help in my test, so waits are short (20 s reveal, 15 s settle) and a new context gets another chance.
- **Sequential scraping with one shared browser.** Slower than parallel, but kinder to a small free instance and to the store's rate limits. Retrying also adds load on a store that is already rate-limiting, which is why backoff doubles.
- **Accepting cookies** to clear the modal is the simplest thing that unblocks the page. It assumes a button named "Accept".

## What my AI tools got wrong the first time

1. **It clicked "Reveal price" immediately.** The first scraper assumed Playwright's built-in waiting would cover a brief enable delay, and it added a `navigator.webdriver` override for good measure. The button is disabled until the pointer moves. A probe recorded it disabled before any movement and enabled after 12 moves. I added the deterministic hover and removed the override, which was unnecessary.
2. **It stored the wrong price with confidence.** It took the first `₹` amount in the price block, which is the struck-through MRP. The data looked valid and was wrong. Selection by meaning, plus the MRP and discount check, fixed it.
3. **It read the price too early.** It parsed as soon as the block reached `price-success`, catching the provisional value. Waiting for "Updating…" to clear was not enough either, because the discount label can lag, so the consistency check now runs inside the wait.
4. **Its diagnostic script produced nonsense.** It joined the digits of MRP, sale price and discount into one number (744655957220), so its "which response contains the price" check found nothing. Its unbounded reads also stalled 30 s and muddied the timeline. I noticed the absurd number and fixed the parsing and timeouts.
5. **Its retry loop was subtly dishonest.** It logged `success` before writing the price, so a failed write could leave both a `success` and a `retried` row for one attempt. It also used linear backoff and reused a page that a timed-out attempt might still be driving. Now history is written first, backoff is exponential, and each attempt gets a fresh context.
6. **It misread the click failures.** The logs were full of 429s, so I first blamed rate limiting. The saved screenshots showed a consent modal covering the page. A first fix that clicked "Accept" once, right after load, could not cover a modal that appears later or is still up when the click happens. Dismissal is now repeated at every point it could get in the way.
7. **Search only looked at the page it had fetched,** so a query missed any product beyond page 1. It now scans the whole catalog, with caching, page spacing and de-duplication.

## Verification and limits

I test the scraper in a real browser against a local mock of the storefront (`npm test`, 15 tests). The mock reproduces the behaviours above: hover gate, 429 chain, decoys, provisional price, lagging label, ignored click, store errors, and a pointer-blocking consent modal. It reproduces my logged failure signature exactly (`locator.click` timeout with no chain requests) on the old code, and passes on the new. Each doubtful-data scenario is asserted to _save nothing_.

The mock proves the logic, not the live store. Against the real store the results vary with load: some runs succeed on the first attempt, some need retries, and some fail all their attempts. The scrape log in the deployed app is the true record. Failures I have not fully explained are prices stuck in "Updating…" and pages whose price block never renders. Both are caught by validation and never stored. With more time I would investigate those two, add alerts and per-product schedules, and add a CI run of the test suite.
