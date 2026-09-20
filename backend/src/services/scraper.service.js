const SCRAPER_VERSION = "v4";

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// SCRAPER_MAX_RETRIES = total attempts per scrape (1 attempt + retries).
const MAX_ATTEMPTS = Math.floor(num(process.env.SCRAPER_MAX_RETRIES, 3));
const STEP_TIMEOUT_MS = num(process.env.SCRAPER_TIMEOUT, 15000);
const NAV_TIMEOUT_MS = 30000;
// Live reveals that worked took ~1-6s (one probe run once took >25s). A stalled
// reveal used to burn 60s per attempt, so fail faster; the retry gets a fresh page.
const REVEAL_TIMEOUT_MS = num(process.env.SCRAPER_REVEAL_TIMEOUT, 20000);
const SETTLE_TIMEOUT_MS = num(process.env.SCRAPER_SETTLE_TIMEOUT, 15000);
const BASE_BACKOFF_MS = num(process.env.SCRAPER_BACKOFF_MS, 3000);

// Deterministic hover: fixed path, fixed timing. No randomness.
const MOVES_PER_SWEEP = 12; // >= 8
const MOVE_GAP_MS = 40;
const DWELL_MS = 700; // >= 600
const ENABLE_GRACE_MS = 3000;
const MAX_HOVER_SWEEPS = 3;

// Seen once on the live store: a click that produced NO request and NO state
// change. If nothing happens shortly after a click, re-hover and click again
// instead of waiting out the whole reveal timeout.
const CLICK_EFFECT_TIMEOUT_MS = 5000;
const MAX_CLICK_TRIES = 3;
const WORST_CASE_HOVER_MS =
  MAX_HOVER_SWEEPS *
  (MOVES_PER_SWEEP * MOVE_GAP_MS + DWELL_MS + ENABLE_GRACE_MS);
const ATTEMPT_TIMEOUT_MS =
  NAV_TIMEOUT_MS +
  STEP_TIMEOUT_MS * 2 +
  REVEAL_TIMEOUT_MS +
  SETTLE_TIMEOUT_MS +
  MAX_CLICK_TRIES * (CLICK_EFFECT_TIMEOUT_MS + WORST_CASE_HOVER_MS) +
  10000;

const STABLE_MS = 700; // price must be unchanged this long before we trust it
const MIN_SETTLED_OPACITY = 0.95;
const MAX_SANE_PRICE = 10_000_000;

const PRICE_RE = /\/api\/products\/[^/?]+\/price(\?|$)/;
const CHALLENGE_RE = /\/api\/challenge(\?|$)/;
const SESSION_RE = /\/api\/session(\?|$)/;
const LAYOUT_RE = /\/api\/layout(\?|$)/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ScrapeError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.code = code;
  }
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ScrapeError("TIMEOUT", `${label} timed out after ${ms}ms`),
        ),
      ms,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------- browser handling ------------------------- */

export async function launchBrowser({ headed = false } = {}) {
  return chromium.launch({
    headless: !headed,
    slowMo: Number(process.env.SCRAPER_SLOW_MO_MS) || 0,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args:
      process.env.SCRAPER_NO_SANDBOX === "true"
        ? ["--no-sandbox", "--disable-setuid-sandbox"]
        : [],
  });
}

/* --------------------------- network capture ------------------------- */

function observeNetwork(page) {
  const obs = {
    challenge: [],
    session: [],
    price: [],
    layout: null,
    activity: 0,
  };

  page.on("request", (req) => {
    const url = req.url();

    if (
      CHALLENGE_RE.test(url) ||
      SESSION_RE.test(url) ||
      PRICE_RE.test(url)
    ) {
      obs.activity += 1;
    }
  });

  page.on("response", (res) => {
    const url = res.url();
    const status = res.status();

    if (CHALLENGE_RE.test(url)) {
      obs.challenge.push(status);
    } else if (SESSION_RE.test(url)) {
      obs.session.push(status);
    } else if (PRICE_RE.test(url)) {
      obs.price.push(status);
    } else if (LAYOUT_RE.test(url) && status === 200) {
      res
        .json()
        .then((j) => {
          obs.layout = {
            revision: j?.revision,
            variant: j?.variant,
          };
        })
        .catch(() => {});
    }
  });

  return obs;
}

function describeNetwork(obs) {
  const list = (label, arr) =>
    `${label}[${arr.join(",") || "-"}]`;

  const layout = obs.layout
    ? ` layout r${obs.layout.revision}/v${obs.layout.variant}`
    : "";

  return `${list("challenge", obs.challenge)} ${list(
    "session",
    obs.session,
  )} ${list("price", obs.price)}${layout}`;
}

/* ------------------------------ hover -------------------------------- */

function buildHoverPath(box) {
  const pts = [
    {
      x: Math.max(1, box.x - 20),
      y: Math.max(1, box.y - 20),
    },
  ];

  for (let i = 0; i < MOVES_PER_SWEEP - 1; i += 1) {
    const t = i / (MOVES_PER_SWEEP - 2);

    pts.push({
      x: box.x + box.width * (0.1 + 0.8 * t),
      y: box.y + box.height * (i % 2 === 0 ? 0.3 : 0.7),
    });
  }

  return pts;
}

async function hoverUntilEnabled(page, priceBlock, revealButton) {
  const box = await priceBlock.boundingBox();

  if (!box) {
    throw new ScrapeError(
      "STRUCTURE_CHANGED",
      ".price-block has no bounding box",
    );
  }

  const path = buildHoverPath(box);
  const startedAt = Date.now();
  let moves = 0;

  for (
    let sweep = 1;
    sweep <= MAX_HOVER_SWEEPS;
    sweep += 1
  ) {
    for (const p of path) {
      await page.mouse.move(p.x, p.y);
      moves += 1;
      await sleep(MOVE_GAP_MS);
    }

    await sleep(DWELL_MS);

    const deadline = Date.now() + ENABLE_GRACE_MS;

    while (Date.now() < deadline) {
      if (await revealButton.isEnabled()) {
        return {
          pointerMoves: moves,
          msToEnabled: Date.now() - startedAt,
        };
      }

      await sleep(25);
    }
  }

  throw new ScrapeError(
    "HOVER_GATE",
    `Reveal button never became enabled after ${moves} pointer moves`,
  );
}

/* ---------------------- reading the rendered price -------------------- */

// Runs inside the page. Scoped to .price-block; no page-wide regex.
function readPriceBlockInPage() {
  const clean = (s) =>
    (s || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const block = document.querySelector(".price-block");

  if (!block) return { found: false };

  const main = block.querySelector(".price-main");
  const blockClasses = [...block.classList];

  if (!main) {
    return {
      found: true,
      hasMain: false,
      blockClasses,
    };
  }

  const isShown = (el) => {
    const cs = getComputedStyle(el);

    return (
      el.getClientRects().length > 0 &&
      cs.display !== "none" &&
      cs.visibility !== "hidden"
    );
  };

  const opacityOf = (el) => {
    let o = 1;

    for (
      let n = el;
      n && n !== block.parentElement;
      n = n.parentElement
    ) {
      const v = parseFloat(getComputedStyle(n).opacity);

      if (!Number.isNaN(v)) {
        o *= v;
      }
    }

    return o;
  };

  const struck = (el) => {
    for (
      let n = el;
      n && n !== block;
      n = n.parentElement
    ) {
      if (
        getComputedStyle(n).textDecorationLine.includes(
          "line-through",
        )
      ) {
        return true;
      }
    }

    return false;
  };

  // Whole element text must be exactly a rupee amount; take the innermost match.
  const AMOUNT = /^₹\s*(\d[\d,]*(?:\.\d{1,2})?)$/;

  const isAmount = (el) =>
    AMOUNT.test(clean(el.textContent));

  const amounts = [...main.querySelectorAll("*")]
    .filter(isAmount)
    .filter(
      (el) =>
        ![...el.querySelectorAll("*")].some(isAmount),
    )
    .map((el) => {
      const text = clean(el.textContent);

      return {
        text,
        value: Number(text.replace(/[^\d.]/g, "")),
        shown: isShown(el),
        ariaHidden: Boolean(
          el.closest('[aria-hidden="true"]'),
        ),
        struck: struck(el),
        opacity: opacityOf(el),
      };
    });

  let discountPercent = null;

  for (const el of main.querySelectorAll("*")) {
    if (el.children.length) continue;

    const m = /^(\d{1,2})\s*%\s*off$/i.exec(
      clean(el.textContent),
    );

    if (m && isShown(el)) {
      discountPercent = Number(m[1]);
      break;
    }
  }

  const updating = [...block.querySelectorAll("*")].some(
    (el) =>
      el.children.length === 0 &&
      isShown(el) &&
      /^(updating|refreshing|loading|please wait)\b/i.test(
        clean(el.textContent),
      ),
  );

  const badge = block.querySelector(".stock-badge");

  const stock = badge
    ? {
        text: clean(badge.textContent),
        classes: [...badge.classList].filter(
          (c) => c !== "stock-badge",
        ),
        shown: isShown(badge),
      }
    : null;

  return {
    found: true,
    hasMain: true,
    blockClasses,
    amounts,
    discountPercent,
    updating,
    stock,
  };
}

function describeSnapshot(snap) {
  if (!snap || !snap.found) {
    return "no price block found";
  }

  const amounts =
    (snap.amounts || [])
      .map(
        (a) =>
          `${a.text}${a.shown ? "" : " hidden"}${
            a.ariaHidden ? " aria-hidden" : ""
          }${a.struck ? " struck" : ""} op=${Number(
            a.opacity,
          ).toFixed(2)}`,
      )
      .join("; ") || "none";

  return `block=[${(snap.blockClasses || []).join(
    " ",
  )}] amounts=[${amounts}] discount=${
    snap.discountPercent
  } updating=${snap.updating} stock=${
    snap.stock ? JSON.stringify(snap.stock.text) : "none"
  }`;
}

function interpretSnapshot(snap) {
  if (!snap.found) {
    return {
      ok: false,
      code: "STRUCTURE_CHANGED",
      reason: "no .price-block",
    };
  }

  if (!snap.hasMain) {
    return {
      ok: false,
      code: "STRUCTURE_CHANGED",
      reason: "no .price-main",
    };
  }

  const visible = snap.amounts.filter(
    (a) => a.shown && !a.ariaHidden,
  );

  const sale = visible.filter((a) => !a.struck);
  const mrp = visible.filter((a) => a.struck);

  if (sale.length !== 1) {
    return {
      ok: false,
      code: "STRUCTURE_CHANGED",
      reason: `expected exactly 1 visible non-struck price, found ${sale.length} (${
        sale.map((s) => s.text).join(", ") || "none"
      })`,
    };
  }

  if (mrp.length > 1) {
    return {
      ok: false,
      code: "STRUCTURE_CHANGED",
      reason: `found ${mrp.length} struck-through prices`,
    };
  }

  const succeeded =
    snap.blockClasses.includes("price-success");

  const settled =
    succeeded &&
    !snap.updating &&
    sale[0].opacity >= MIN_SETTLED_OPACITY;

  return {
    ok: true,
    settled,
    reason: settled
      ? "settled"
      : `not settled yet (success=${succeeded}, updating=${snap.updating}, opacity=${sale[0].opacity.toFixed(
          2,
        )})`,
    sale: sale[0],
    mrp: mrp[0] || null,
    discountPercent: snap.discountPercent,
    stock: snap.stock,
  };
}

// Returns a description of the problem, or null if price/MRP/discount agree.
function consistencyProblem(s) {
  const price = s.sale.value;

  if (!s.mrp) return null;

  if (!(s.mrp.value >= price)) {
    return `sale price ₹${price} is higher than MRP ₹${s.mrp.value}`;
  }

  if (s.discountPercent != null) {
    const implied = Math.round(
      (1 - price / s.mrp.value) * 100,
    );

    if (Math.abs(implied - s.discountPercent) > 1) {
      return `price ₹${price} contradicts MRP ₹${s.mrp.value} and "${s.discountPercent}% off" (implies ${implied}%) - likely a provisional value`;
    }
  }

  return null;
}

/**
 * Validate before anything is saved.
 * Throws ScrapeError("VALIDATION") on any doubt.
 */
export function validateScrapedData(s) {
  const price = s?.sale?.value;

  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    price > MAX_SANE_PRICE
  ) {
    throw new ScrapeError(
      "VALIDATION",
      `price is not a sane positive number: ${price}`,
    );
  }

  const problem = consistencyProblem(s);

  if (problem) {
    throw new ScrapeError("VALIDATION", problem);
  }

  if (
    !s.stock ||
    !s.stock.shown ||
    !s.stock.text ||
    s.stock.text.length > 120
  ) {
    throw new ScrapeError(
      "VALIDATION",
      "stock badge missing, hidden or empty",
    );
  }

  const qty = /\d[\d,]*/.exec(s.stock.text);

  return {
    price,
    mrp: s.mrp ? s.mrp.value : null,
    discountPercent: s.discountPercent ?? null,
    stockStatus: s.stock.text,
    stockQuantity: qty
      ? Number(qty[0].replace(/,/g, ""))
      : null,
  };
}

async function readSettledPrice(page) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let lastKey = null;
  let stableSince = 0;
  let last = {
    reason: "no reading taken",
  };
  let lastSnap = null;

  while (Date.now() < deadline) {
    const snap = await page.evaluate(
      readPriceBlockInPage,
    );

    lastSnap = snap;
    last = interpretSnapshot(snap);

    if (last.ok && last.settled) {
      // The discount label can lag behind the price.
      // Keep waiting for it to catch up.
      const problem = consistencyProblem(last);

      if (problem) {
        last = {
          ...last,
          settled: false,
          code: "VALIDATION",
          reason: `inconsistent: ${problem}`,
        };

        lastKey = null;
      } else {
        const key = JSON.stringify([
          last.sale.value,
          last.mrp?.value,
          last.discountPercent,
          last.stock?.text,
        ]);

        if (key === lastKey) {
          if (
            Date.now() - stableSince >= STABLE_MS
          ) {
            return last;
          }
        } else {
          lastKey = key;
          stableSince = Date.now();
        }
      }
    } else {
      lastKey = null;
    }

    await sleep(150);
  }

  throw new ScrapeError(
    last.code || "NOT_SETTLED",
    `Price did not settle within ${SETTLE_TIMEOUT_MS}ms: ${last.reason} | ${describeSnapshot(
      lastSnap,
    )}`,
  );
}

/* --------------------------- click verification ----------------------- */

async function clickTookEffect(
  page,
  net,
  activityBefore,
) {
  const deadline =
    Date.now() + CLICK_EFFECT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (net.activity > activityBefore) {
      return true;
    }

    const stillIdle = await page
      .evaluate(
        () =>
          document
            .querySelector(".price-block")
            ?.classList.contains("price-idle") ?? true,
      )
      .catch(() => true);

    if (!stillIdle) {
      return true;
    }

    await sleep(100);
  }

  return false;
}

// Observation only.
async function describeClickState(page) {
  const s = await page
    .evaluate(() => {
      const btn = [
        ...document.querySelectorAll("button"),
      ].find((b) =>
        /reveal price/i.test(
          b.getAttribute("aria-label") ||
            b.textContent ||
            "",
        ),
      );

      return {
        obs: window.__scraperObs,
        buttonEnabled: btn ? !btn.disabled : null,
        blockClass:
          document.querySelector(".price-block")
            ?.className ?? null,
      };
    })
    .catch(() => null);

  if (!s) {
    return "page state unavailable";
  }

  const btn =
    s.buttonEnabled === null
      ? "gone"
      : s.buttonEnabled
        ? "enabled"
        : "disabled";

  return `page saw pointermove=${s.obs?.pointermove} pointerdown=${s.obs?.pointerdown} click=${s.obs?.click}, button ${btn}, block "${s.blockClass}"`;
}

/* --------------------------- one scrape attempt ----------------------- */

/**
 * Full flow on an already-created page:
 * load -> hover -> wait enabled -> click -> wait for the
 * store's own success/error state -> wait until price is settled -> validate.
 */
export async function scrapeProductPage(
  page,
  productUrl,
) {
  const net = observeNetwork(page);
  const t0 = Date.now();

  try {
    await page.addInitScript(() => {
      window.__scraperObs = {
        pointermove: 0,
        pointerdown: 0,
        click: 0,
      };

      for (const t of [
        "pointermove",
        "pointerdown",
        "click",
      ]) {
        document.addEventListener(
          t,
          () => {
            window.__scraperObs[t] += 1;
          },
          true,
        );
      }
    });

    await page.goto(productUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    // Dismiss the cookie banner if present.
    // It can sit on top of the price block and intercept clicks/hover.
    await page
      .locator("button", {
        hasText: /accept/i,
      })
      .first()
      .click({ timeout: 3000 })
      .catch(() => {});

    const priceBlock = page
      .locator(".price-block")
      .first();

    await priceBlock.waitFor({
      state: "visible",
      timeout: NAV_TIMEOUT_MS,
    });

    await priceBlock.scrollIntoViewIfNeeded();

    const alreadyRevealed =
      await page.evaluate(() =>
        document
          .querySelector(".price-block")
          ?.classList.contains("price-success"),
      );

    let hover = {
      pointerMoves: 0,
      msToEnabled: 0,
    };

    let revealStartedAt = Date.now();

    if (!alreadyRevealed) {
      const reveal = page
        .locator("button.btn.btn-primary", {
          hasText: /reveal price/i,
        })
        .first();

      await reveal.waitFor({
        state: "visible",
        timeout: STEP_TIMEOUT_MS,
      });

      for (
        let tryNo = 1;
        tryNo <= MAX_CLICK_TRIES;
        tryNo += 1
      ) {
        const h = await hoverUntilEnabled(
          page,
          priceBlock,
          reveal,
        );

        hover = {
          pointerMoves:
            hover.pointerMoves + h.pointerMoves,
          msToEnabled:
            hover.msToEnabled || h.msToEnabled,
        };

        revealStartedAt = Date.now();

        const activityBefore = net.activity;

        // IMPORTANT FIX:
        // The click itself can throw a Playwright TimeoutError.
        // Catch it so MAX_CLICK_TRIES can actually retry.
        let clickError = null;

        try {
          await reveal.click({
            timeout: STEP_TIMEOUT_MS,
          });
        } catch (error) {
          clickError = error;
        }

        // Normal successful click and the store started doing something.
        if (
          !clickError &&
          (await clickTookEffect(
            page,
            net,
            activityBefore,
          ))
        ) {
          break;
        }

        const state =
          await describeClickState(page);

        if (tryNo === MAX_CLICK_TRIES) {
          const firstLine = String(
            clickError?.message ||
              clickError ||
              "",
          ).split("\n")[0];

          throw new ScrapeError(
            "CLICK_NO_EFFECT",
            clickError
              ? `Reveal click failed after ${tryNo} attempts (${firstLine}) | ${state} | ${describeNetwork(
                  net,
                )}`
              : `Clicked Reveal ${tryNo}x with no request and no state change | ${state} | ${describeNetwork(
                  net,
                )}`,
          );
        }

        console.warn(
          clickError
            ? `[scraper] (${SCRAPER_VERSION}) click ${tryNo} failed: ${String(
                clickError.message || clickError,
              ).split("\n")[0]}; re-hovering and trying again`
            : `[scraper] (${SCRAPER_VERSION}) click ${tryNo} had no effect (${state}); re-hovering and trying again`,
        );
      }

      // The store's own state class is the success/failure signal.
      try {
        await page.waitForFunction(
          () => {
            const el =
              document.querySelector(
                ".price-block",
              );

            return (
              Boolean(el) &&
              (el.classList.contains(
                "price-success",
              ) ||
                el.classList.contains(
                  "price-error",
                ))
            );
          },
          null,
          {
            timeout: REVEAL_TIMEOUT_MS,
          },
        );
      } catch {
        throw new ScrapeError(
          "REVEAL_TIMEOUT",
          `Reveal did not finish within ${REVEAL_TIMEOUT_MS}ms | requestsStarted=${net.activity} | ${await describeClickState(
            page,
          )} | ${describeNetwork(net)}`,
        );
      }

      const isError = await page.evaluate(() =>
        document
          .querySelector(".price-block")
          ?.classList.contains("price-error"),
      );

      if (isError) {
        const text =
          (await priceBlock
            .textContent()
            .catch(() => "")) || "";

        throw new ScrapeError(
          "REVEAL_ERROR",
          `Store reported a price-reveal error: "${text
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 150)}" | ${describeNetwork(net)}`,
        );
      }
    }

    const settled =
      await readSettledPrice(page);

    const data =
      validateScrapedData(settled);

    return {
      ...data,
      meta: {
        pointerMoves: hover.pointerMoves,
        msToEnabled: hover.msToEnabled,
        msRevealToSettled:
          Date.now() - revealStartedAt,
        msTotal: Date.now() - t0,
      },
      netSummary: describeNetwork(net),
    };
  } catch (error) {
    if (error instanceof ScrapeError) {
      if (!error.message.includes("challenge[")) {
        error.message += ` | ${describeNetwork(net)}`;
      }

      throw error;
    }

    const firstLine = String(
      error?.message || error,
    ).split("\n")[0];

    const code =
      error?.name === "TimeoutError"
        ? "TIMEOUT"
        : "BROWSER";

    throw new ScrapeError(
      code,
      `${firstLine} | ${describeNetwork(net)}`,
    );
  }
}

/* ------------------------------ orchestration ------------------------- */

// Only when SCRAPER_DEBUG_DIR is set: save the price block's HTML and
// a screenshot of a failed attempt. Never allowed to break scraping itself.
async function dumpDebug(page, attempt) {
  const dir = process.env.SCRAPER_DEBUG_DIR;

  if (!dir || !page) return;

  try {
    await fs.mkdir(dir, {
      recursive: true,
    });

    const base = `${dir}/fail-${Date.now()}-a${attempt}`;

    const html = await page
      .evaluate(
        () =>
          document.querySelector(
            ".price-block",
          )?.outerHTML ?? "(no .price-block)",
      )
      .catch(() => "(page unavailable)");

    await fs.writeFile(
      `${base}.html`,
      html.replace(
        /[\u200B-\u200D\uFEFF]/g,
        "<ZW>",
      ),
      "utf8",
    );

    await page
      .screenshot({
        path: `${base}.png`,
      })
      .catch(() => {});

    console.warn(
      `[scraper] (${SCRAPER_VERSION}) saved debug files: ${base}.html and ${base}.png`,
    );
  } catch {
    /* ignore */
  }
}

function checkStoreHost(productUrl) {
  const storeBase =
    process.env.STORE_BASE_URL?.trim() ||
    "https://demo.inelabteamdev.com";

  try {
    const allowed =
      new URL(storeBase).origin;

    const actual =
      new URL(productUrl).origin;

    if (actual !== allowed) {
      return `Refusing to scrape ${actual}: only ${allowed} is allowed`;
    }

    return null;
  } catch {
    return `Invalid product URL: ${productUrl}`;
  }
}

function successMessage(s) {
  const mrp = s.mrp
    ? ` (MRP ₹${s.mrp}${
        s.discountPercent != null
          ? `, ${s.discountPercent}% off`
          : ""
      })`
    : "";

  return (
    `Scraped ₹${s.price}${mrp} / stock "${s.stockStatus}" | ` +
    `pointer moves ${s.meta.pointerMoves}, enabled after ${s.meta.msToEnabled}ms, ` +
    `reveal->settled ${s.meta.msRevealToSettled}ms | ${s.netSummary}`
  );
}

/**
 * Scrapes one tracked product with retries + exponential backoff.
 * Writes ONE scrape_logs row per attempt, and writes price_history ONLY
 * after a fully validated success.
 *
 * @param {object} tracked row from tracked_products
 * @param {object} [opts]
 */
export async function scrapeTrackedProduct(
  tracked,
  {
    sharedBrowser = null,
    browserProvider = null,
    headed = false,
    dryRun = false,
    beforeAttempt = null,
  } = {},
) {
  const trackedProductId = tracked?.id;
  const productUrl = tracked?.product_url;

  if (!trackedProductId || !productUrl) {
    throw new Error(
      "scrapeTrackedProduct requires tracked.id and tracked.product_url.",
    );
  }

  const record = async (entry) => {
    console.log(
      `[scraper] (${SCRAPER_VERSION}) ${trackedProductId} attempt ${entry.attempt}/${MAX_ATTEMPTS} ${entry.status}: ${entry.message}`,
    );

    if (!dryRun) {
      await saveScrapeLog({
        trackedProductId,
        ...entry,
      });
    }
  };

  const guardError =
    checkStoreHost(productUrl);

  if (guardError) {
    const now =
      new Date().toISOString();

    await record({
      attempt: 1,
      status: "failed",
      message: guardError,
      price: null,
      stockStatus: null,
      error: guardError,
      startedAt: now,
      finishedAt: now,
    });

    return {
      success: false,
      error: guardError,
    };
  }

  let ownBrowser = null;

  const acquireBrowser = async () => {
    if (browserProvider) {
      return browserProvider();
    }

    if (sharedBrowser) {
      if (!sharedBrowser.isConnected()) {
        throw new ScrapeError(
          "BROWSER",
          "shared browser is disconnected",
        );
      }

      return sharedBrowser;
    }

    if (
      !ownBrowser ||
      !ownBrowser.isConnected()
    ) {
      await ownBrowser
        ?.close()
        .catch(() => {});

      ownBrowser =
        await launchBrowser({
          headed,
        });
    }

    return ownBrowser;
  };

  let lastError = null;

  try {
    for (
      let attempt = 1;
      attempt <= MAX_ATTEMPTS;
      attempt += 1
    ) {
      const startedAt =
        new Date().toISOString();

      let context = null;
      let page = null;

      try {
        const browser =
          await acquireBrowser();

        // Fresh context per attempt:
        // no cookies/session/state carried over.
        context =
          await browser.newContext({
            viewport: {
              width: 1400,
              height: 1100,
            },
          });

        page =
          await context.newPage();

        page.setDefaultTimeout(
          STEP_TIMEOUT_MS,
        );

        if (beforeAttempt) {
          await beforeAttempt({
            page,
            attempt,
          });
        }

        const scraped =
          await withTimeout(
            scrapeProductPage(
              page,
              productUrl,
            ),
            ATTEMPT_TIMEOUT_MS,
            `scrape attempt ${attempt}`,
          );

        // History first: a scrape is only "success"
        // if the data is stored.
        if (!dryRun) {
          await savePriceHistory({
            trackedProductId,
            price: scraped.price,
            stockStatus:
              scraped.stockStatus,
          });
        }

        await record({
          attempt,
          status: "success",
          message:
            successMessage(scraped),
          price: scraped.price,
          stockStatus:
            scraped.stockStatus,
          error: null,
          startedAt,
          finishedAt:
            new Date().toISOString(),
        });

        return {
          success: true,
          attempt,
          price: scraped.price,
          mrp: scraped.mrp,
          discountPercent:
            scraped.discountPercent,
          stockStatus:
            scraped.stockStatus,
          stockQuantity:
            scraped.stockQuantity,
        };
      } catch (error) {
        lastError = error;

        await dumpDebug(
          page,
          attempt,
        );

        const isFinal =
          attempt >= MAX_ATTEMPTS;

        await record({
          attempt,
          status: isFinal
            ? "failed"
            : "retried",
          message: error.message,
          price: null,
          stockStatus: null,
          error: error.message,
          startedAt,
          finishedAt:
            new Date().toISOString(),
        });

        if (isFinal) {
          break;
        }

        await sleep(
          BASE_BACKOFF_MS *
            2 ** (attempt - 1),
        );
      } finally {
        await context
          ?.close()
          .catch(() => {});
      }
    }

    return {
      success: false,
      error:
        lastError?.message ||
        "Unknown scrape failure",
    };
  } finally {
    await ownBrowser
      ?.close()
      .catch(() => {});
  }
}

/**
 * Scrapes every active tracked product, sharing one browser
 * (relaunched automatically if it crashes).
 * One product failing never stops the rest.
 */
export async function scrapeAllTrackedProducts(
  trackedProducts,
  { headed = false } = {},
) {
  let browser = null;

  const browserProvider = async () => {
    if (
      !browser ||
      !browser.isConnected()
    ) {
      await browser
        ?.close()
        .catch(() => {});

      browser =
        await launchBrowser({
          headed,
        });
    }

    return browser;
  };

  const results = [];

  try {
    for (const tracked of trackedProducts) {
      try {
        const outcome =
          await scrapeTrackedProduct(
            tracked,
            {
              browserProvider,
              headed,
            },
          );

        results.push({
          trackedProductId:
            tracked.id,
          ...outcome,
        });
      } catch (error) {
        results.push({
          trackedProductId:
            tracked.id,
          success: false,
          error: error.message,
        });
      }
    }
  } finally {
    await browser
      ?.close()
      .catch(() => {});
  }

  return results;
}