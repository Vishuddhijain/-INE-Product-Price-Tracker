# Design Note: Hybrid scraper strategy

## Problem

The storefront hides price information until a user interacts with the product page. A static HTML fetch is not enough to collect a trustworthy current selling price. The detail page expects a hover or reveal interaction before the price appears, which means the scraper must drive a browser context rather than just parse markup.

## Design decision

The application is intentionally split into two levels:

1. Lightweight catalog search layer
   - Uses the storefront's public catalog API at `/api/catalog`
   - Returns paginated product metadata with IDs, slugs, SKUs, category, and brand
   - Allows fast multi-product discovery without launching a browser for every listing

2. Dynamic detail layer
   - Uses Playwright for product pages
   - Opens the product URL in a real browser session
   - Accepts cookies if present
   - Moves over the `.price-block` area to emulate the reveal interaction
   - Waits for the hidden price and stock text to render
   - Parses the current price only after the UI has actually revealed it

## Why this is reliable

- The catalog API is stable and lightweight for search and browsing
- The browser layer matches the user behavior that the storefront depends on
- The scraper avoids brittle assumptions about hidden DOM text that is not yet rendered
- Retry and timeout handling prevent transient failures from causing false negatives

## Persistence strategy

The backend is designed to preserve the project's existing Supabase structure without resetting or re-creating the database. The service layer writes into existing tables when they are available and intentionally falls back gracefully when a table column is missing or the DB is partially configured.

## Scope and boundaries

- This phase focuses on the backend scraping and tracking logic.
- The React frontend has not been built yet, as requested.
- The implementation prioritizes real scraper reliability over UI completeness.
