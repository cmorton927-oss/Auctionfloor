// AuctionFloor — Render port entry point.
// Node 20 + Express serving the React client, Postgres via Drizzle.
// Build:  npm install && npm run build
// Start:  node server.js   (listens on $PORT, Render sets it)
import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, stripeWebhookHandler } from "./server/api.js";
import { migrate } from "./server/migrate.js";
import { finalizeEndedAuctions } from "./server/finalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Minimal cookie parser (avoids an extra dependency).
app.use((req, res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k) req.cookies[decodeURIComponent(k)] = decodeURIComponent(v.join("=") || "");
    }
  }
  next();
});

// Stripe webhook needs the raw body for signature verification — mount
// it BEFORE express.json().
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res, next) => {
  stripeWebhookHandler(req, res).catch(next);
});

app.use(express.json({ limit: "12mb" }));
app.use("/api", api);

// Listing photos (disk storage; see README for the S3 follow-up).
app.use("/uploads", express.static(UPLOADS_DIR));

// React client (built by `npm run build` into dist/).
const clientDist = path.join(__dirname, "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/uploads/")) return res.status(404).json({ error: "Not found" });
    res.sendFile(path.join(clientDist, "index.html"));
  });
} else {
  app.get("/", (req, res) => res.json({ ok: true, note: "AuctionFloor API is running. Build the client with `npm run build`." }));
}

// Error handler — zod/validation errors carry .status; everything else 500.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Something went wrong." });
});

async function start() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — see .env.example. The server cannot start without Postgres.");
    process.exit(1);
  }
  await migrate();
  // Finalize ended auctions every minute, so sales/invoices are created
  // even if nobody happens to hit listAuctions at that moment.
  setInterval(() => finalizeEndedAuctions().catch((e) => console.error("finalize error:", e.message)), 60 * 1000);
  app.listen(PORT, () => {
    console.log(`AuctionFloor listening on port ${PORT} (APP_URL=${process.env.APP_URL || "https://auction423.com"})`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
