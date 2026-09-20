import "dotenv/config";
import express from "express";
import cors from "cors";

import { supabase } from "./lib/supabase.js";
import productsRoutes from "./routes/products.routes.js";
import trackingRoutes from "./routes/tracking.routes.js";
import scrapeRoutes from "./routes/scrape.routes.js";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 5000);

app.get("/", (req, res) => {
  res.json({
    message: "INE Product Price Tracker API is running",
    mode: "hybrid-scraper",
    status: "ok"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "INE Product Price Tracker Backend"
  });
});

app.get("/api/test-db", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({
      success: false,
      error: "Supabase is not configured."
    });
  }

  try {
    const { data, error } = await supabase
      .from("tracked_products")
      .select("*")
      .limit(10);

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    res.json({
      success: true,
      count: data.length,
      products: data
    });
  } catch (error) {
    console.error("Database test failed:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.use(productsRoutes);
app.use(trackingRoutes);
app.use(scrapeRoutes);

app.use((err, req, res, next) => {
  console.error("Unhandled API error:", err);
  res.status(err.statusCode || 500).json({
    success: false,
    error: err.message || "Internal Server Error"
  });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});