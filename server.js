// AuctionFloor — Render port entry point.
// Node 20 + Express serving the React client, Postgres via Drizzle.
// Build:  npm install && npm run build
// Start:  node server.js   (listens on $PORT, Render sets it)
import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asc, desc, eq, gt } from "drizzle-orm";
import { api, stripeWebhookHandler } from "./server/api.js";
import { migrate } from "./server/migrate.js";
import { finalizeEndedAuctions } from "./server/finalize.js";
import { db } from "./server/db.js";
import * as schema from "./server/schema.js";
import { carName, money } from "./server/fees.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_URL = (process.env.APP_URL || "https://auction423.com").replace(/\/$/, "");
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

// 100mb: a listing can carry up to 8 photos at ~11 MB of base64 each.
app.use(express.json({ limit: "100mb" }));
app.use("/api", api);

// Listing photos (disk storage; see README for the S3 follow-up).
app.use("/uploads", express.static(UPLOADS_DIR));

// React client (built by `npm run build` into dist/).
const clientDist = path.join(__dirname, "dist");

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// The cover photo as an absolute URL (for og:image). listing_photos
// position 0 wins; falls back to the legacy single imagePath/imageUrl.
async function listingCoverUrl(row) {
  const photos = await db.select().from(schema.listingPhotos)
    .where(eq(schema.listingPhotos.listingId, row.id))
    .orderBy(asc(schema.listingPhotos.position)).limit(1);
  if (photos[0]) return `${APP_URL}/uploads/${photos[0].imagePath}`;
  if (row.imagePath) return `${APP_URL}/uploads/${row.imagePath}`;
  if (row.imageUrl) return row.imageUrl.startsWith("http") ? row.imageUrl : `${APP_URL}${row.imageUrl.startsWith("/") ? "" : "/"}${row.imageUrl}`;
  return null;
}

// Dynamic sitemap: homepage + one URL per LIVE listing. Registered
// before express.static so no file can shadow it (there is no static
// sitemap.xml anymore — it was replaced by this route).
app.get("/sitemap.xml", async (req, res) => {
  const homepageOnly = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${APP_URL}/</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n`;
  try {
    const live = await db.select({ id: schema.listings.id })
      .from(schema.listings)
      .where(gt(schema.listings.endsAt, new Date()))
      .orderBy(asc(schema.listings.endsAt));
    const urls = [
      { loc: `${APP_URL}/`, changefreq: "daily", priority: "1.0" },
      ...live.map((l) => ({ loc: `${APP_URL}/listing/${l.id}`, changefreq: "hourly", priority: "0.8" })),
    ];
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`).join("\n")}\n</urlset>\n`;
    res.type("application/xml").send(body);
  } catch (e) {
    // Never 500 a sitemap — crawlers still get the homepage.
    console.error("sitemap error:", e.message);
    res.type("application/xml").send(homepageOnly);
  }
});

// Per-listing pages: serve index.html with listing-specific title /
// description / Open Graph tags injected, so a shared link shows the
// car in Facebook/iMessage previews (those crawlers don't run JS).
// Unknown ids fall back to the default tags — the client shows the
// "listing not found" notice on the floor instead.
app.get("/listing/:id", async (req, res, next) => {
  const indexPath = path.join(clientDist, "index.html");
  if (!fs.existsSync(indexPath)) return next();
  let html = fs.readFileSync(indexPath, "utf8");
  const id = Number(req.params.id);
  if (Number.isSafeInteger(id) && id > 0) {
    try {
      const rows = await db.select().from(schema.listings).where(eq(schema.listings.id, id)).limit(1);
      const row = rows[0];
      if (row) {
        const name = carName(row);
        const topBid = await db.select({ amount: schema.bids.amount }).from(schema.bids)
          .where(eq(schema.bids.listingId, id)).orderBy(desc(schema.bids.amount)).limit(1);
        const price = topBid[0] ? topBid[0].amount : row.startingPrice;
        const priceLabel = topBid[0] ? "Current bid" : "Starting bid";
        // NOTE: named metaDesc, not desc — `desc` is the drizzle sort
        // helper imported above, and a local `const desc` here would
        // shadow it (temporal dead zone) and break the topBid query.
        const metaDesc = `${name} · ${Number(row.mileage).toLocaleString()} mi · ${row.condition} · ${row.location}. ${priceLabel} ${money(price)} — bid now on AuctionFloor.`;
        const url = `${APP_URL}/listing/${row.id}`;
        const image = await listingCoverUrl(row);
        html = html
          .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(name)} — AuctionFloor</title>`)
          .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${escapeHtml(metaDesc)}" />`)
          .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${escapeHtml(name)} — AuctionFloor" />`)
          .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${escapeHtml(metaDesc)}" />`)
          .replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${escapeHtml(url)}" />`);
        const extra = [
          image ? `<meta property="og:image" content="${escapeHtml(image)}" />` : null,
          `<link rel="canonical" href="${escapeHtml(url)}" />`,
        ].filter(Boolean).join("\n    ");
        html = html.replace(/<meta property="og:type" content="website" \/>/, (m) => `${m}\n    ${extra}`);
      }
    } catch (e) {
      console.error("listing meta error:", e.message);
    }
  }
  res.type("text/html").send(html);
});

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
