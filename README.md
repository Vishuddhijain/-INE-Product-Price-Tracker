# INE Product Price Tracker

This repository contains the backend for an INE mock storefront price tracker built around a hybrid scraping strategy. The app uses a lightweight catalog API fetch for the storefront listing and a Playwright-based browser scrape for the dynamic product-price reveal flow.

## What is implemented

- Catalog search via the live storefront `/api/catalog` API
- Product detail lookup by ID
- Dynamic price reveal flow using Playwright to hover over the price block and load the hidden price
- tracking routes for saved products and scrape logs
- Supabase persistence for tracked products, price history, and scrape logs
- Express API layer with validation and retry handling

## Current backend API

- `GET /` — service status
- `GET /api/health` — health check
- `GET /api/products/search?q=<term>&page=<n>&pageSize=<n>` — catalog search
- `GET /api/products/:id` — product lookup + detail scrape
- `GET /api/tracked-products` — list tracked products
- `POST /api/tracked-products` — create a tracked product record
- `GET /api/tracked-products/:id/history` — saved price history
- `GET /api/tracked-products/:id/logs` — scrape logs
- `POST /api/tracked-products/:id/scrape` — run a single tracked scrape
- `POST /api/scrape/run` — catalog scrape entrypoint
- `POST /api/scrape/tracked` — bulk tracked scrape entrypoint

## Run locally

From the backend directory:

```bash
cd backend
npm install
npm start
```

The service listens on port `5000` by default.

## Environment

The app expects a `.env` file in `backend/` with at least:

```env
PORT=5000
STORE_BASE_URL=https://demo.inelabteamdev.com
SUPABASE_URL=https://<project>.supabase.co/rest/v1/
SUPABASE_SECRET_KEY=<secret>
SCRAPER_TIMEOUT=15000
SCRAPER_MAX_RETRIES=3
```

## Notes on scraper reliability

The storefront intentionally hides product pricing until the user interacts with the price area. The implementation follows the live behavior rather than parsing static HTML alone:

1. catalog search uses the public `/api/catalog` endpoint and filters results in the app
2. product details are loaded in a real browser session via Playwright
3. mouse movement is applied on the `.price-block` area to trigger the reveal logic
4. price and stock text are only accepted after the UI reveals them

This keeps the scraper resilient against the dynamic UI behavior used by the demo storefront.
