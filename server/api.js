// REST API for AuctionFloor (Render port).
// Endpoints mirror the original Muse artifact actions 1:1, as
// POST /api/<action> with a JSON body. Validation uses zod, exactly
// like the original. No Muse agent delegation anywhere.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db.js";
import * as schema from "./schema.js";
import {
  STRIPE_ACCOUNT_NAME,
  buyerFeeFor,
  buyerFeeRate,
  carName,
  money,
  moneyCents,
  adminFeeCentsFor,
  saleTotalDueCents,
} from "./fees.js";
import { applyVerifiedStripePayment, createCheckoutForSale, finalizeEndedAuctions, releasePayoutIfReady } from "./finalize.js";
import { buyerSellerOwnerEntries, getOwnerSettingsRow, notifySaleParties } from "./notify.js";
import { createFirstOwner, loginOwner, logoutOwner, ownerCookieOptions, ownerExists, ownerFromRequest, OWNER_COOKIE } from "./auth.js";
import { getStripe, retrieveCheckoutSession, stripeConfigured } from "./stripe.js";
import { checkLocalRadius } from "./geo.js";
import { notifyNewListing, subscribeAlert, unsubscribeAlert } from "./alerts.js";

export const api = Router();

const phoneField = z.string().trim().min(7, "A contact phone number is required").max(40);
const emailField = z.string().trim().email("A valid contact email is required").max(160);
const CONDITIONS = ["Runs & drives", "Runs, needs work", "Not running", "Parts / salvage"];
const TITLES = ["Clean title", "Rebuilt / salvage title", "No title — bill of sale", "Lien / other"];

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
}
function parseBody(schemaDef, body) {
  const result = schemaDef.safeParse(body ?? {});
  if (!result.success) {
    const err = new Error(result.error.issues.map((i) => i.message).join("; "));
    err.status = 400;
    throw err;
  }
  return result.data;
}
function iso(d) {
  return d ? new Date(d).toISOString() : null;
}

async function requireOwner(req, res, next) {
  const owner = await ownerFromRequest(req);
  if (!owner) {
    const err = new Error("Only the site owner can do that — log in first.");
    err.status = 403;
    return next(err);
  }
  req.owner = owner;
  return next();
}

function uploadsDir() {
  return process.env.UPLOADS_DIR || path.join(process.cwd(), "uploads");
}

async function toListingOut(row, bidRows, watchedIds, sale, photoPaths = []) {
  const sorted = [...bidRows].sort((a, b) => b.amount - a.amount);
  const top = sorted[0];
  const currentBid = top ? top.amount : null;
  // Photos: the listing_photos rows (position order), falling back to the
  // legacy single imagePath / imageUrl for listings created before
  // multi-photo support. imageUrl stays the first photo (the cover).
  const photos = photoPaths.length > 0
    ? photoPaths.map((p) => `/uploads/${p}`)
    : (row.imagePath ? [`/uploads/${row.imagePath}`] : (row.imageUrl ? [row.imageUrl] : []));
  return {
    id: row.id,
    year: row.year,
    make: row.make,
    model: row.model,
    trim: row.trim ?? null,
    mileage: row.mileage,
    condition: row.condition,
    titleStatus: row.titleStatus,
    location: row.location,
    zipCode: row.zipCode ?? null,
    description: row.description,
    imageUrl: photos[0] ?? null,
    photos,
    sellerName: row.privateSeller ? "Private seller" : row.sellerName,
    privateSeller: row.privateSeller ?? false,
    noMechanicalIssuesConfirmed: row.noMechanicalIssuesConfirmed ?? false,
    buyNowPrice: row.buyNowPrice ?? null,
    startingPrice: row.startingPrice,
    reservePrice: row.reservePrice ?? null,
    reserveMet: row.reservePrice == null ? true : (currentBid != null && currentBid >= row.reservePrice),
    currentBid,
    bidCount: bidRows.length,
    highBidder: top ? top.bidderName : null,
    endsAt: iso(row.endsAt),
    createdAt: iso(row.createdAt),
    isEnded: new Date(row.endsAt).getTime() <= Date.now(),
    isWatched: watchedIds.has(row.id),
    sale: sale
      ? {
          status: sale.status,
          amount: sale.amount ?? null,
          buyerFee: sale.buyerFee ?? null,
          sellerFee: sale.sellerFee ?? null,
          processingFee: sale.processingFee ?? null,
          winnerName: sale.winnerName ?? null,
          stripePaymentStatus: sale.stripePaymentStatus ?? null,
          invoicePaidAt: iso(sale.invoicePaidAt),
        }
      : null,
  };
}

function toCheckoutOut(sale, listing) {
  const amount = sale.amount ?? null;
  const fee = sale.buyerFee ?? null;
  const processingFee = amount != null ? (sale.processingFee ?? adminFeeCentsFor(amount + (fee ?? 0))) : null;
  return {
    found: true,
    car: carName(listing),
    listingId: listing.id,
    amount,
    buyerFee: fee,
    processingFee,
    totalDue: amount != null ? amount + (fee ?? 0) + (processingFee ?? 0) / 100 : null,
    buyerName: sale.winnerName ?? null,
    sellerName: listing.sellerName,
    invoiceSentAt: iso(sale.invoiceSentAt),
    invoicePaidAt: iso(sale.invoicePaidAt),
    buyerPickupConfirmedAt: iso(sale.buyerPickupConfirmedAt),
    sellerPickupConfirmedAt: iso(sale.sellerPickupConfirmedAt),
    payoutReleasedAt: iso(sale.payoutReleasedAt),
    deliveryRequestedAt: iso(sale.deliveryRequestedAt),
    deliveryAddress: sale.deliveryAddress ?? null,
    deliveryNotes: sale.deliveryNotes ?? null,
    deliveryQuoteCents: sale.deliveryQuoteCents ?? null,
    deliveryQuotedAt: iso(sale.deliveryQuotedAt),
    deliveryBuyerAgreedAt: iso(sale.deliveryBuyerAgreedAt),
    deliverySellerAgreedAt: iso(sale.deliverySellerAgreedAt),
    stripePaymentStatus: sale.invoicePaidAt ? "paid" : (sale.stripePaymentStatus ?? "not_started"),
    stripeCheckoutUrl: sale.stripeCheckoutUrl ?? null,
    stripeCheckoutSessionId: sale.stripeCheckoutSessionId ?? null,
    stripePaymentIntentId: sale.stripePaymentIntentId ?? null,
    stripeAccountName: STRIPE_ACCOUNT_NAME,
    stripeLivemode: sale.stripeLivemode != null ? sale.stripeLivemode : true,
    stripeCheckoutCreatedAt: iso(sale.stripeCheckoutCreatedAt),
    stripeLastCheckedAt: iso(sale.stripeLastCheckedAt),
  };
}
const emptyCheckout = {
  found: false, car: null, listingId: null, amount: null, buyerFee: null, processingFee: null, totalDue: null,
  buyerName: null, sellerName: null, invoiceSentAt: null, invoicePaidAt: null,
  buyerPickupConfirmedAt: null, sellerPickupConfirmedAt: null, payoutReleasedAt: null,
  deliveryRequestedAt: null, deliveryAddress: null, deliveryNotes: null,
  deliveryQuoteCents: null, deliveryQuotedAt: null, deliveryBuyerAgreedAt: null, deliverySellerAgreedAt: null,
  stripePaymentStatus: null, stripeCheckoutUrl: null, stripeCheckoutSessionId: null, stripePaymentIntentId: null,
  stripeAccountName: null, stripeLivemode: null, stripeCheckoutCreatedAt: null, stripeLastCheckedAt: null,
};

async function loadSaleByCode(accessCode) {
  const code = String(accessCode || "").trim().toUpperCase();
  if (code.length < 6) return null;
  const saleRows = await db.select().from(schema.sales).where(eq(schema.sales.accessToken, code));
  const sale = saleRows[0];
  if (!sale || sale.status !== "sold") return null;
  const listingRows = await db.select().from(schema.listings).where(eq(schema.listings.id, sale.listingId));
  const listing = listingRows[0];
  if (!listing) return null;
  return { sale, listing };
}

// ---- Health ---------------------------------------------------------------
api.get("/health", (req, res) => res.json({ ok: true, stripeConfigured: stripeConfigured() }));

// ---- Owner auth -----------------------------------------------------------
api.get("/owner/status", asyncHandler(async (req, res) => {
  const owner = await ownerFromRequest(req);
  res.json({ ownerExists: await ownerExists(), isOwner: Boolean(owner), email: owner?.email ?? "" });
}));
api.post("/owner/setup", asyncHandler(async (req, res) => {
  const { email, password } = parseBody(z.object({ email: emailField, password: z.string().min(8, "Password must be at least 8 characters") }), req.body);
  const user = await createFirstOwner(email, password);
  const { token, expiresAt } = await loginOwner(email, password);
  res.cookie(OWNER_COOKIE, token, { ...ownerCookieOptions(), expires: expiresAt });
  res.json({ ok: true, email: user.email });
}));
api.post("/owner/login", asyncHandler(async (req, res) => {
  const { email, password } = parseBody(z.object({ email: emailField, password: z.string().min(1) }), req.body);
  const { token, expiresAt, user } = await loginOwner(email, password);
  res.cookie(OWNER_COOKIE, token, { ...ownerCookieOptions(), expires: expiresAt });
  res.json({ ok: true, email: user.email });
}));
api.post("/owner/logout", asyncHandler(async (req, res) => {
  await logoutOwner(req.cookies?.[OWNER_COOKIE]);
  res.clearCookie(OWNER_COOKIE, { path: "/" });
  res.json({ ok: true });
}));

// ---- Auctions -------------------------------------------------------------
api.post("/listAuctions", asyncHandler(async (req, res) => {
  const args = parseBody(z.object({
    search: z.string().default(""), filter: z.enum(["live", "ending", "ended", "watched", "all"]).default("live"),
    condition: z.string().default(""), sort: z.enum(["ending", "price_low", "price_high", "newest"]).default("ending"),
  }), req.body);
  await finalizeEndedAuctions();
  const rows = await db.select().from(schema.listings).orderBy(asc(schema.listings.endsAt));
  const watchRows = await db.select().from(schema.watches);
  const watchedIds = new Set(watchRows.map((w) => w.listingId));
  const allBids = await db.select().from(schema.bids);
  const saleRows = await db.select().from(schema.sales);
  const saleByListing = new Map(saleRows.map((s) => [s.listingId, s]));
  const photoRows = await db.select().from(schema.listingPhotos).orderBy(asc(schema.listingPhotos.listingId), asc(schema.listingPhotos.position));
  const photosByListing = new Map();
  for (const p of photoRows) {
    if (!photosByListing.has(p.listingId)) photosByListing.set(p.listingId, []);
    photosByListing.get(p.listingId).push(p.imagePath);
  }
  const out = await Promise.all(rows.map((r) => toListingOut(r, allBids.filter((b) => b.listingId === r.id), watchedIds, saleByListing.get(r.id), photosByListing.get(r.id) ?? [])));
  const now = Date.now();
  const stats = {
    live: out.filter((l) => !l.isEnded).length,
    ended: out.filter((l) => l.isEnded).length,
    totalBids: allBids.length,
    watched: watchedIds.size,
  };
  let filtered = out;
  const q = args.search.trim().toLowerCase();
  if (q) filtered = filtered.filter((l) => `${l.year} ${l.make} ${l.model} ${l.trim ?? ""} ${l.location}`.toLowerCase().includes(q));
  if (args.condition) filtered = filtered.filter((l) => l.condition === args.condition);
  if (args.filter === "live") filtered = filtered.filter((l) => !l.isEnded);
  if (args.filter === "ended") filtered = filtered.filter((l) => l.isEnded);
  if (args.filter === "watched") filtered = filtered.filter((l) => l.isWatched);
  if (args.filter === "ending") filtered = filtered.filter((l) => !l.isEnded && new Date(l.endsAt).getTime() - now < 24 * 3600 * 1000);
  const price = (l) => l.currentBid ?? l.startingPrice;
  if (args.sort === "ending") filtered.sort((a, b) => new Date(a.endsAt).getTime() - new Date(b.endsAt).getTime());
  if (args.sort === "price_low") filtered.sort((a, b) => price(a) - price(b));
  if (args.sort === "price_high") filtered.sort((a, b) => price(b) - price(a));
  if (args.sort === "newest") filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json({ listings: filtered, stats });
}));

api.post("/getAuction", asyncHandler(async (req, res) => {
  const { id } = parseBody(z.object({ id: z.number().int().positive() }), req.body);
  await finalizeEndedAuctions();
  const rows = await db.select().from(schema.listings).where(eq(schema.listings.id, id));
  const row = rows[0];
  if (!row) { const e = new Error("Listing not found"); e.status = 404; throw e; }
  const watchRows = await db.select().from(schema.watches);
  const watchedIds = new Set(watchRows.map((w) => w.listingId));
  const allForListing = await db.select().from(schema.bids).where(eq(schema.bids.listingId, id));
  const saleRows = await db.select().from(schema.sales).where(eq(schema.sales.listingId, id));
  const photoRows = await db.select().from(schema.listingPhotos).where(eq(schema.listingPhotos.listingId, id)).orderBy(asc(schema.listingPhotos.position));
  const listing = await toListingOut(row, allForListing, watchedIds, saleRows[0], photoRows.map((p) => p.imagePath));
  const bidRows = await db.select().from(schema.bids).where(eq(schema.bids.listingId, id)).orderBy(desc(schema.bids.createdAt));
  res.json({ listing, bids: bidRows.map((b) => ({ id: b.id, bidderName: b.bidderName, amount: b.amount, createdAt: iso(b.createdAt) })) });
}));

api.post("/createListing", asyncHandler(async (req, res) => {
  const args = parseBody(z.object({
    year: z.number().int().min(1900).max(2030),
    make: z.string().min(1).max(60), model: z.string().min(1).max(60), trim: z.string().max(60).default(""),
    mileage: z.number().int().min(0).max(2000000),
    condition: z.enum(CONDITIONS), titleStatus: z.enum(TITLES),
    location: z.string().min(1).max(120), description: z.string().min(1).max(4000),
    zipCode: z.string().regex(/^\d{5}$/, "Enter a 5-digit ZIP code"),
    photo: z.object({ dataBase64: z.string().min(1).max(15_000_000), mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]) }).nullable().default(null),
    photos: z.array(z.object({ dataBase64: z.string().min(1).max(15_000_000), mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]) })).max(8, "Up to 8 photos per listing.").default([]),
    sellerName: z.string().min(1).max(80), sellerPhone: phoneField, sellerEmail: emailField,
    privateSeller: z.boolean().default(false),
    noMechanicalIssuesConfirmed: z.boolean().default(false),
    startingPrice: z.number().int().min(1).max(10000000),
    reservePrice: z.number().int().min(0).max(10000000).default(0),
    buyNowPrice: z.number().int().min(0).max(10000000).default(0),
    durationHours: z.number().int().min(1).max(24 * 14),
  }), req.body);
  // Photos: the `photos` array (up to 8) wins; the legacy single `photo`
  // field is kept for older clients. The first photo is the cover photo
  // (also stored as listings.imagePath for backward compatibility).
  const photoInputs = (args.photos ?? []).length > 0 ? args.photos : (args.photo ? [args.photo] : []);
  const savedPaths = [];
  for (const p of photoInputs) {
    const bytes = Buffer.from(p.dataBase64, "base64");
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) throw new Error("That photo could not be read — try a smaller image file.");
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[p.mimeType];
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
    fs.mkdirSync(uploadsDir(), { recursive: true });
    fs.writeFileSync(path.join(uploadsDir(), filename), bytes);
    savedPaths.push(filename);
  }
  const imagePath = savedPaths[0] ?? null;
  const endsAt = new Date(Date.now() + args.durationHours * 3600 * 1000);
  if (args.condition === "Runs & drives" && !args.noMechanicalIssuesConfirmed) {
    throw new Error("A vehicle listed as Runs & drives needs the seller to confirm it has no mechanical issues.");
  }
  if (args.buyNowPrice > 0 && args.buyNowPrice < args.startingPrice) {
    throw new Error("The Buy Now price can't be lower than the starting bid.");
  }
  const radius = checkLocalRadius(args.zipCode);
  if (!radius.ok) throw new Error(radius.reason);
  const inserted = await db.insert(schema.listings).values({
    year: args.year, make: args.make.trim(), model: args.model.trim(), trim: args.trim.trim() || null,
    mileage: args.mileage, condition: args.condition, titleStatus: args.titleStatus,
    location: args.location.trim(), zipCode: args.zipCode, description: args.description.trim(),
    imageUrl: null, imagePath,
    sellerName: args.sellerName.trim(), sellerPhone: args.sellerPhone.trim(), sellerEmail: args.sellerEmail.trim(),
    privateSeller: args.privateSeller,
    noMechanicalIssuesConfirmed: args.noMechanicalIssuesConfirmed,
    startingPrice: args.startingPrice, reservePrice: args.reservePrice > 0 ? args.reservePrice : null, buyNowPrice: args.buyNowPrice > 0 ? args.buyNowPrice : null, endsAt,
  }).returning({ id: schema.listings.id });
  if (!inserted[0]) throw new Error("Failed to create listing");
  if (savedPaths.length > 0) {
    await db.insert(schema.listingPhotos).values(savedPaths.map((imagePath, position) => ({ listingId: inserted[0].id, imagePath, position })));
  }
  // New-listing email alerts go out in the background; a failure or a
  // missing email setup never blocks the listing.
  notifyNewListing({ ...args, id: inserted[0].id, trim: args.trim.trim() || null, location: args.location.trim(), zipCode: args.zipCode }).catch(() => {});
  res.json({ id: inserted[0].id });
}));

// New-listing email alerts: subscribe with just an email address, and
// unsubscribe from the link in any alert email.
api.post("/subscribeAlerts", asyncHandler(async (req, res) => {
  const args = parseBody(z.object({ email: z.string().trim().email("Enter a valid email address.").max(160) }), req.body);
  res.json(await subscribeAlert(args.email));
}));

api.get("/unsubscribeAlerts", asyncHandler(async (req, res) => {
  const ok = await unsubscribeAlert(req.query.token);
  res.type("html").send(ok
    ? "<!doctype html><title>Unsubscribed — AuctionFloor</title><body style=\"font-family:sans-serif;text-align:center;padding:80px 20px\"><h1>You're unsubscribed.</h1><p>You won't get new-listing emails from AuctionFloor anymore.</p><p><a href=\"/\">Back to AuctionFloor</a></p></body>"
    : "<!doctype html><title>Link not found — AuctionFloor</title><body style=\"font-family:sans-serif;text-align:center;padding:80px 20px\"><h1>That link isn't valid anymore.</h1><p>You may already be unsubscribed. <a href=\"/\">Back to AuctionFloor</a></p></body>");
}));

api.post("/placeBid", asyncHandler(async (req, res) => {
  const args = parseBody(z.object({
    listingId: z.number().int().positive(),
    bidderName: z.string().min(1).max(80), bidderPhone: phoneField, bidderEmail: emailField,
    amount: z.number().int().min(1).max(10000000),
  }), req.body);
  const rows = await db.select().from(schema.listings).where(eq(schema.listings.id, args.listingId));
  const listing = rows[0];
  if (!listing) throw new Error("Listing not found");
  if (new Date(listing.endsAt).getTime() <= Date.now()) throw new Error("This auction has ended");
  const bidRows = await db.select().from(schema.bids).where(eq(schema.bids.listingId, args.listingId)).orderBy(desc(schema.bids.amount));
  const top = bidRows[0];
  const minimum = top ? top.amount + 1 : listing.startingPrice;
  if (args.amount < minimum) throw new Error(`Bid must be at least $${minimum.toLocaleString()}`);
  await db.insert(schema.bids).values({
    listingId: args.listingId, bidderName: args.bidderName.trim(),
    bidderPhone: args.bidderPhone.trim(), bidderEmail: args.bidderEmail.trim(), amount: args.amount,
  });
  let extended = false;
  let newEndsAt = listing.endsAt;
  if (new Date(listing.endsAt).getTime() - Date.now() < 2 * 60 * 1000) {
    newEndsAt = new Date(Date.now() + 2 * 60 * 1000);
    await db.update(schema.listings).set({ endsAt: newEndsAt }).where(eq(schema.listings.id, args.listingId));
    extended = true;
  }
  res.json({ ok: true, extended, newEndsAt: iso(newEndsAt) });
}));

api.post("/buyNow", asyncHandler(async (req, res) => {
  const args = parseBody(z.object({
    listingId: z.number().int().positive(),
    buyerName: z.string().min(1).max(80), buyerPhone: phoneField, buyerEmail: emailField,
  }), req.body);
  const rows = await db.select().from(schema.listings).where(eq(schema.listings.id, args.listingId));
  const listing = rows[0];
  if (!listing) throw new Error("Listing not found");
  if (new Date(listing.endsAt).getTime() <= Date.now()) throw new Error("This auction has ended");
  const existingSale = await db.select().from(schema.sales).where(eq(schema.sales.listingId, args.listingId));
  if (existingSale.length > 0) throw new Error("This auction has already closed");
  if (listing.buyNowPrice == null) throw new Error("This listing has no Buy Now price");
  const bidRows = await db.select().from(schema.bids).where(eq(schema.bids.listingId, args.listingId)).orderBy(desc(schema.bids.amount));
  const top = bidRows[0];
  if (top && top.amount >= listing.buyNowPrice) throw new Error("Bidding has already passed the Buy Now price");
  // Close the auction now, record the Buy Now purchase as the winning bid,
  // and let the normal finalize sweep create the sale, invoice, win
  // messages, and Stripe checkout exactly like a won bid. The reserve is
  // cleared: the Buy Now price is the seller's explicit sell-now price.
  await db.update(schema.listings).set({ endsAt: new Date(), reservePrice: null }).where(eq(schema.listings.id, args.listingId));
  await db.insert(schema.bids).values({
    listingId: args.listingId, bidderName: args.buyerName.trim(),
    bidderPhone: args.buyerPhone.trim(), bidderEmail: args.buyerEmail.trim(), amount: listing.buyNowPrice,
  });
  await finalizeEndedAuctions();
  const saleRows = await db.select().from(schema.sales).where(eq(schema.sales.listingId, args.listingId));
  const sale = saleRows[0];
  if (!sale || sale.status !== "sold") throw new Error("The Buy Now purchase couldn't be completed — try again or place a bid.");
  res.json({ ok: true, saleId: sale.id, accessToken: sale.accessToken ?? null, amount: sale.amount ?? listing.buyNowPrice });
}));

api.post("/toggleWatch", asyncHandler(async (req, res) => {
  const { listingId } = parseBody(z.object({ listingId: z.number().int().positive() }), req.body);
  const existing = await db.select().from(schema.watches).where(eq(schema.watches.listingId, listingId));
  if (existing.length > 0) {
    await db.delete(schema.watches).where(eq(schema.watches.listingId, listingId));
    return res.json({ watched: false });
  }
  await db.insert(schema.watches).values({ listingId });
  res.json({ watched: true });
}));

api.post("/deleteListing", asyncHandler(async (req, res) => {
  const { id } = parseBody(z.object({ id: z.number().int().positive() }), req.body);
  const rows = await db.select().from(schema.listings).where(eq(schema.listings.id, id));
  const row = rows[0];
  const photoRows = await db.select().from(schema.listingPhotos).where(eq(schema.listingPhotos.listingId, id));
  await db.delete(schema.messages).where(eq(schema.messages.listingId, id));
  await db.delete(schema.sales).where(eq(schema.sales.listingId, id));
  await db.delete(schema.bids).where(eq(schema.bids.listingId, id));
  await db.delete(schema.watches).where(eq(schema.watches.listingId, id));
  await db.delete(schema.listingPhotos).where(eq(schema.listingPhotos.listingId, id));
  await db.delete(schema.listings).where(eq(schema.listings.id, id));
  if (row?.imagePath) { try { fs.unlinkSync(path.join(uploadsDir(), row.imagePath)); } catch { /* already gone */ } }
  for (const p of photoRows) { try { fs.unlinkSync(path.join(uploadsDir(), p.imagePath)); } catch { /* already gone */ } }
  res.json({ ok: true });
}));

// ---- Messages / checkout --------------------------------------------------
api.post("/listMyMessages", asyncHandler(async (req, res) => {
  const { accessCode } = parseBody(z.object({ accessCode: z.string().default("") }), req.body);
  await finalizeEndedAuctions();
  const code = String(accessCode || "").trim().toUpperCase();
  if (code.length < 6) return res.json({ messages: [] });
  const saleRows = await db.select().from(schema.sales).where(eq(schema.sales.accessToken, code));
  const sale = saleRows[0];
  if (!sale) return res.json({ messages: [] });
  const listings = await db.select().from(schema.listings).where(eq(schema.listings.id, sale.listingId));
  const listing = listings[0];
  const rows = await db.select().from(schema.messages).where(eq(schema.messages.saleId, sale.id)).orderBy(desc(schema.messages.createdAt));
  res.json({
    messages: rows
      .filter((m) => m.deliveryChannel === "in_app" && m.recipientRole !== "owner")
      .map((m) => ({
        id: m.id, listingId: m.listingId, car: listing ? carName(listing) : "Auction",
        role: m.recipientRole, recipientName: m.recipientName, body: m.body,
        channel: m.deliveryChannel, sentAt: iso(m.sentAt), createdAt: iso(m.createdAt),
      })),
  });
}));

api.post("/getSaleCheckout", asyncHandler(async (req, res) => {
  const { accessCode } = parseBody(z.object({ accessCode: z.string().default("") }), req.body);
  await finalizeEndedAuctions();
  const found = await loadSaleByCode(accessCode);
  if (!found) return res.json(emptyCheckout);
  res.json(toCheckoutOut(found.sale, found.listing));
}));

api.post("/createStripeCheckout", asyncHandler(async (req, res) => {
  const { accessCode } = parseBody(z.object({ accessCode: z.string().min(6).max(20) }), req.body);
  const found = await loadSaleByCode(accessCode);
  if (!found) throw new Error("No sale found for that access code.");
  const { sale, listing } = found;
  if (sale.invoicePaidAt) return res.json(toCheckoutOut(sale, listing));
  const status = sale.stripePaymentStatus ?? "not_started";
  if (sale.stripeCheckoutUrl && status === "open") return res.json(toCheckoutOut(sale, listing));
  if (!stripeConfigured()) {
    const e = new Error("Card payments are not set up yet — the site owner needs to add the Stripe key (STRIPE_SECRET_KEY).");
    e.status = 503;
    throw e;
  }
  if (status !== "creating") {
    await db.update(schema.sales).set({ stripePaymentStatus: "creating", stripeCheckoutUrl: null, stripeCheckoutSessionId: null }).where(eq(schema.sales.id, sale.id));
    sale.stripePaymentStatus = "creating";
    sale.stripeCheckoutUrl = null;
    sale.stripeCheckoutSessionId = null;
    await createCheckoutForSale(listing, sale);
  }
  const fresh = await db.select().from(schema.sales).where(eq(schema.sales.id, sale.id));
  res.json(toCheckoutOut(fresh[0], listing));
}));

api.post("/checkStripePayment", asyncHandler(async (req, res) => {
  const { accessCode } = parseBody(z.object({ accessCode: z.string().min(6).max(20) }), req.body);
  const found = await loadSaleByCode(accessCode);
  if (!found) throw new Error("No sale found for that access code.");
  const { sale, listing } = found;
  if (sale.invoicePaidAt) return res.json(toCheckoutOut(sale, listing));
  if (!sale.stripeCheckoutSessionId) {
    if (!stripeConfigured()) {
      const e = new Error("Card payments are not set up yet — the site owner needs to add the Stripe key (STRIPE_SECRET_KEY).");
      e.status = 503;
      throw e;
    }
    if ((sale.stripePaymentStatus ?? "not_started") !== "creating") {
      await db.update(schema.sales).set({ stripePaymentStatus: "creating" }).where(eq(schema.sales.id, sale.id));
      sale.stripePaymentStatus = "creating";
      await createCheckoutForSale(listing, sale);
    }
    const fresh = await db.select().from(schema.sales).where(eq(schema.sales.id, sale.id));
    return res.json(toCheckoutOut(fresh[0], listing));
  }
  // Re-read the session directly from Stripe — the ONLY path that can
  // mark an invoice paid. Never the buyer's word for it.
  const session = await retrieveCheckoutSession(sale.stripeCheckoutSessionId);
  await db.update(schema.sales).set({ stripeLastCheckedAt: new Date(), stripeLivemode: session.livemode }).where(eq(schema.sales.id, sale.id));
  sale.stripeLastCheckedAt = new Date();
  if (session.paymentIntentId) {
    await db.update(schema.sales).set({ stripePaymentIntentId: session.paymentIntentId }).where(eq(schema.sales.id, sale.id));
    sale.stripePaymentIntentId = session.paymentIntentId;
  }
  const expected = saleTotalDueCents(sale);
  const verifiedPaid = session.paymentStatus === "paid" && session.status === "complete" && session.amountTotalCents === expected;
  if (verifiedPaid) {
    await applyVerifiedStripePayment(listing, sale);
  } else if (session.status === "expired") {
    await db.update(schema.sales).set({ stripePaymentStatus: "expired", stripeCheckoutUrl: null }).where(eq(schema.sales.id, sale.id));
    sale.stripePaymentStatus = "expired";
  } else if (!sale.invoicePaidAt) {
    await db.update(schema.sales).set({ stripePaymentStatus: "open" }).where(eq(schema.sales.id, sale.id));
    sale.stripePaymentStatus = "open";
  }
  const fresh = await db.select().from(schema.sales).where(eq(schema.sales.id, sale.id));
  res.json(toCheckoutOut(fresh[0], listing));
}));

api.post("/confirmPickup", asyncHandler(async (req, res) => {
  const args = parseBody(z.object({ accessCode: z.string().min(6).max(20), role: z.enum(["buyer", "seller"]) }), req.body);
  const found = await loadSaleByCode(args.accessCode);
  if (!found) throw new Error("No sale found for that access code.");
  const { sale, listing } = found;
  const car = carName(listing);
  if (args.role === "buyer" && !sale.buyerPickupConfirmedAt) {
    await db.update(schema.sales).set({ buyerPickupConfirmedAt: new Date() }).where(eq(schema.sales.id, sale.id));
    sale.buyerPickupConfirmedAt = new Date();
    if (!sale.sellerPickupConfirmedAt) {
      const entries = await buyerSellerOwnerEntries(listing, sale, {
        buyer: `You confirmed pickup of the ${car}. The seller still needs to confirm — once they do${sale.invoicePaidAt ? "" : " and your invoice is paid"}, the seller's payout of ${money(sale.amount ?? 0)} is released.`,
        seller: `The buyer confirmed pickup of the ${car}. Please confirm the pickup too in the AuctionFloor checkout under Messages — once both sides confirm${sale.invoicePaidAt ? "" : " and the buyer's invoice is paid"}, your payout of ${money(sale.amount ?? 0)} is released.`,
        owner: `Pickup update — the buyer confirmed pickup of the ${car}; waiting on the seller to confirm.${sale.invoicePaidAt ? " Invoice is paid." : " Invoice is not paid yet."}`,
      });
      await notifySaleParties(listing, sale, `Pickup confirmed by buyer: ${car} — AuctionFloor`, entries);
    }
  }
  if (args.role === "seller" && !sale.sellerPickupConfirmedAt) {
    await db.update(schema.sales).set({ sellerPickupConfirmedAt: new Date() }).where(eq(schema.sales.id, sale.id));
    sale.sellerPickupConfirmedAt = new Date();
    if (!sale.buyerPickupConfirmedAt) {
      const entries = await buyerSellerOwnerEntries(listing, sale, {
        buyer: `The seller confirmed the pickup of the ${car}. Please confirm the pickup too in the AuctionFloor checkout under Messages — once both sides confirm${sale.invoicePaidAt ? "" : " and your invoice is paid"}, the seller gets paid.`,
        seller: `You confirmed pickup of the ${car}. The buyer still needs to confirm — once they do${sale.invoicePaidAt ? "" : " and their invoice is paid"}, your payout of ${money(sale.amount ?? 0)} is released.`,
        owner: `Pickup update — the seller confirmed pickup of the ${car}; waiting on the buyer to confirm.${sale.invoicePaidAt ? " Invoice is paid." : " Invoice is not paid yet."}`,
      });
      await notifySaleParties(listing, sale, `Pickup confirmed by seller: ${car} — AuctionFloor`, entries);
    }
  }
  await releasePayoutIfReady(listing, sale);
  const fresh = await db.select().from(schema.sales).where(eq(schema.sales.id, sale.id));
  res.json(toCheckoutOut(fresh[0], listing));
}));

api.post("/requestDelivery", asyncHandler(async (req, res) => {
  const args = parseBody(z.object({
    accessCode: z.string().min(6).max(20),
    deliveryAddress: z.string().trim().min(5, "Enter the delivery address").max(300),
    deliveryNotes: z.string().trim().max(1000).default(""),
  }), req.body);
  const found = await loadSaleByCode(args.accessCode);
  if (!found) throw new Error("No sale found for that access code.");
  const { sale, listing } = found;
  if (!sale.deliveryRequestedAt) {
    await db.update(schema.sales).set({ deliveryRequestedAt: new Date(), deliveryAddress: args.deliveryAddress, deliveryNotes: args.deliveryNotes || null }).where(eq(schema.sales.id, sale.id));
    sale.deliveryRequestedAt = new Date();
    sale.deliveryAddress = args.deliveryAddress;
    sale.deliveryNotes = args.deliveryNotes || null;
    const car = carName(listing);
    const buyerContact = [sale.winnerPhone, sale.winnerEmail].filter(Boolean).join(" · ") || "not provided";
    const notesLine = args.deliveryNotes ? ` Notes: ${args.deliveryNotes}` : "";
    const entries = await buyerSellerOwnerEntries(listing, sale, {
      buyer: `Delivery requested for the ${car} — the site owner will personally arrange the haul from the seller (${listing.location}) to ${args.deliveryAddress}. Delivery is priced per trip — no flat rate, no per-mile rate: the owner will quote the cost for this trip in the AuctionFloor checkout under Messages, and you'll see the quoted price and agree to it there before the haul is booked.${notesLine}`,
      seller: `Delivery requested for your ${car} — instead of a pickup, the site owner will personally arrange delivery from you (${listing.location}) to the buyer at ${args.deliveryAddress}. Delivery is priced per trip — no flat rate, no per-mile rate: the owner will quote the cost for this trip in the AuctionFloor checkout under Messages, and you'll see the quoted price and agree to it there before the haul is booked. The buyer is ${sale.winnerName ?? "the buyer"} — ${buyerContact}.${notesLine}`,
      owner: `Delivery request — please arrange delivery of the ${car} from seller ${listing.sellerName} (${listing.location}; ${[listing.sellerPhone, listing.sellerEmail].filter(Boolean).join(" · ")}) to buyer ${sale.winnerName ?? ""} at ${args.deliveryAddress} (${buyerContact}). Quote the delivery cost per trip in the AuctionFloor owner tab (Messages → Owner — fees & settings → Delivery requests): the quoted price is shown to both buyer and seller in the checkout, and each side agrees to it before the haul is booked.${notesLine}`,
    });
    await notifySaleParties(listing, sale, `Delivery requested: ${car} — AuctionFloor`, entries);
  }
  const fresh = await db.select().from(schema.sales).where(eq(schema.sales.id, sale.id));
  res.json(toCheckoutOut(fresh[0], listing));
}));

api.post("/agreeToDelivery", asyncHandler(async (req, res) => {
  const args = parseBody(z.object({ accessCode: z.string().min(6).max(20), role: z.enum(["buyer", "seller"]) }), req.body);
  const found = await loadSaleByCode(args.accessCode);
  if (!found) throw new Error("No sale found for that access code.");
  const { sale, listing } = found;
  if (sale.deliveryQuoteCents == null) throw new Error("There's no delivery quote to agree to yet — the owner quotes the per-trip price first.");
  const car = carName(listing);
  const price = moneyCents(sale.deliveryQuoteCents);
  let added = false;
  if (args.role === "buyer" && !sale.deliveryBuyerAgreedAt) {
    await db.update(schema.sales).set({ deliveryBuyerAgreedAt: new Date() }).where(eq(schema.sales.id, sale.id));
    sale.deliveryBuyerAgreedAt = new Date(); added = true;
  }
  if (args.role === "seller" && !sale.deliverySellerAgreedAt) {
    await db.update(schema.sales).set({ deliverySellerAgreedAt: new Date() }).where(eq(schema.sales.id, sale.id));
    sale.deliverySellerAgreedAt = new Date(); added = true;
  }
  const bothAgreed = sale.deliveryBuyerAgreedAt != null && sale.deliverySellerAgreedAt != null;
  if (added && bothAgreed) {
    const entries = await buyerSellerOwnerEntries(listing, sale, {
      buyer: `Delivery booked — both you and the seller agreed to the quoted price of ${price} for delivering the ${car} from ${listing.location} to ${sale.deliveryAddress ?? "the delivery address"}. The site owner will personally arrange the haul and contact you to schedule it.`,
      seller: `Delivery booked — both you and the buyer agreed to the quoted price of ${price} for delivering your ${car} from ${listing.location} to ${sale.deliveryAddress ?? "the delivery address"}. The site owner will personally arrange the haul and contact you to schedule it.`,
      owner: `Delivery booked at the quoted price — buyer (${sale.winnerName ?? ""}) and seller (${listing.sellerName}) both agreed to ${price} for the ${car} haul from ${listing.location} to ${sale.deliveryAddress ?? ""}. Time to arrange the haul and contact both sides to schedule it.`,
    });
    await notifySaleParties(listing, sale, `Delivery booked at ${price}: ${car} — AuctionFloor`, entries);
  } else if (added && !bothAgreed) {
    const entries = await buyerSellerOwnerEntries(listing, sale, {
      buyer: args.role === "buyer"
        ? `You agreed to the delivery quote of ${price} for the ${car}. The seller still needs to agree in the checkout — delivery is booked once both sides have agreed.`
        : `The seller agreed to the delivery quote of ${price} for the ${car}. You still need to agree in the AuctionFloor checkout under Messages — delivery is booked once both sides have agreed.`,
      seller: args.role === "seller"
        ? `You agreed to the delivery quote of ${price} for your ${car}. The buyer still needs to agree in the checkout — delivery is booked once both sides have agreed.`
        : `The buyer agreed to the delivery quote of ${price} for your ${car}. You still need to agree in the AuctionFloor checkout under Messages — delivery is booked once both sides have agreed.`,
      owner: `Delivery quote update — the ${args.role} agreed to ${price} for the ${car} haul; waiting on the ${args.role === "buyer" ? "seller" : "buyer"} to agree before it's booked.`,
    });
    await notifySaleParties(listing, sale, `Delivery quote agreed by ${args.role}: ${car} — AuctionFloor`, entries);
  }
  const fresh = await db.select().from(schema.sales).where(eq(schema.sales.id, sale.id));
  res.json(toCheckoutOut(fresh[0], listing));
}));

// ---- Owner-only -----------------------------------------------------------
api.post("/quoteDelivery", requireOwner, asyncHandler(async (req, res) => {
  const args = parseBody(z.object({ saleId: z.number().int().positive(), quoteCents: z.number().int().min(1, "Enter the quoted delivery price").max(100000000) }), req.body);
  const saleRows = await db.select().from(schema.sales).where(eq(schema.sales.id, args.saleId));
  const sale = saleRows[0];
  if (!sale || sale.status !== "sold") throw new Error("Sale not found.");
  if (!sale.deliveryRequestedAt) throw new Error("No delivery has been requested for this sale yet.");
  if (sale.deliveryBuyerAgreedAt && sale.deliverySellerAgreedAt) throw new Error("Both sides already agreed to the quoted delivery price — this delivery is booked at that price.");
  const listingRows = await db.select().from(schema.listings).where(eq(schema.listings.id, sale.listingId));
  const listing = listingRows[0];
  if (!listing) throw new Error("Listing not found.");
  const wasRequote = sale.deliveryQuoteCents != null;
  await db.update(schema.sales).set({ deliveryQuoteCents: args.quoteCents, deliveryQuotedAt: new Date(), deliveryBuyerAgreedAt: null, deliverySellerAgreedAt: null }).where(eq(schema.sales.id, sale.id));
  const car = carName(listing);
  const price = moneyCents(args.quoteCents);
  const requoteLine = wasRequote ? " This replaces the earlier quote — any earlier agreement no longer counts." : "";
  const entries = await buyerSellerOwnerEntries(listing, sale, {
    buyer: `Delivery quote for the ${car}: ${price} for the whole trip — quoted per trip by the site owner (no flat rate, no per-mile rate), for delivery from the seller (${listing.location}) to ${sale.deliveryAddress ?? "the delivery address"}. Open the checkout under Messages on AuctionFloor with your access code to see the quote and tap "Buyer: agree to delivery at ${price}" — delivery is booked only once both you and the seller have agreed to this price.${requoteLine}`,
    seller: `Delivery quote for your ${car}: ${price} for the whole trip — quoted per trip by the site owner (no flat rate, no per-mile rate), for delivery from you (${listing.location}) to the buyer at ${sale.deliveryAddress ?? "the delivery address"}. Open the checkout under Messages on AuctionFloor with your access code to see the quote and tap "Seller: agree to delivery at ${price}" — delivery is booked only once both you and the buyer have agreed to this price.${requoteLine}`,
    owner: `Delivery quote sent — ${price} per trip for the ${car} (from ${listing.location} to ${sale.deliveryAddress ?? ""}). Buyer (${sale.winnerName ?? ""}) and seller (${listing.sellerName}) have been shown the quote and each must agree to it in the checkout before the haul is booked.${requoteLine}`,
  });
  await notifySaleParties(listing, sale, `Delivery quote ${price}: ${car} — AuctionFloor`, entries);
  res.json({ ok: true });
}));

api.post("/listDeliveryRequests", requireOwner, asyncHandler(async (req, res) => {
  await finalizeEndedAuctions();
  const saleRows = await db.select().from(schema.sales).orderBy(desc(schema.sales.deliveryRequestedAt));
  const listings = await db.select().from(schema.listings);
  const byId = new Map(listings.map((l) => [l.id, l]));
  res.json({
    requests: saleRows.filter((s) => s.deliveryRequestedAt != null).map((s) => {
      const l = byId.get(s.listingId);
      return {
        saleId: s.id, listingId: s.listingId, car: l ? carName(l) : "Auction",
        pickupLocation: l ? l.location : "", deliveryAddress: s.deliveryAddress ?? null, deliveryNotes: s.deliveryNotes ?? null,
        deliveryRequestedAt: iso(s.deliveryRequestedAt), buyerName: s.winnerName ?? null,
        buyerContact: [s.winnerPhone, s.winnerEmail].filter(Boolean).join(" · ") || "not provided",
        sellerName: l ? l.sellerName : "",
        sellerContact: l ? [l.sellerPhone, l.sellerEmail].filter(Boolean).join(" · ") || "not provided" : "",
        deliveryQuoteCents: s.deliveryQuoteCents ?? null, deliveryQuotedAt: iso(s.deliveryQuotedAt),
        deliveryBuyerAgreedAt: iso(s.deliveryBuyerAgreedAt), deliverySellerAgreedAt: iso(s.deliverySellerAgreedAt),
      };
    }),
  });
}));

api.post("/listOwnerMessages", requireOwner, asyncHandler(async (req, res) => {
  await finalizeEndedAuctions();
  const rows = await db.select().from(schema.messages).orderBy(desc(schema.messages.createdAt));
  const listings = await db.select().from(schema.listings);
  const byId = new Map(listings.map((l) => [l.id, l]));
  res.json({
    messages: rows.filter((m) => m.recipientRole === "owner").map((m) => ({
      id: m.id, listingId: m.listingId, car: byId.get(m.listingId) ? carName(byId.get(m.listingId)) : "Auction",
      role: "owner", recipientName: m.recipientName, body: m.body,
      channel: m.deliveryChannel, sentAt: iso(m.sentAt), createdAt: iso(m.createdAt),
    })),
  });
}));

api.post("/getOwnerContact", asyncHandler(async (req, res) => {
  const owner = await ownerFromRequest(req);
  if (!owner) return res.json({ ownerName: "", ownerPhone: "", ownerEmail: "", isSet: false, isOwner: false });
  const row = await getOwnerSettingsRow();
  if (!row) return res.json({ ownerName: "", ownerPhone: "", ownerEmail: "", isSet: false, isOwner: true });
  res.json({ ownerName: row.ownerName, ownerPhone: row.ownerPhone, ownerEmail: row.ownerEmail, isSet: true, isOwner: true });
}));

api.post("/saveOwnerContact", requireOwner, asyncHandler(async (req, res) => {
  const args = parseBody(z.object({ ownerName: z.string().min(1).max(80), ownerPhone: phoneField, ownerEmail: emailField }), req.body);
  const values = { ownerName: args.ownerName.trim(), ownerPhone: args.ownerPhone.trim(), ownerEmail: args.ownerEmail.trim(), updatedAt: new Date() };
  const rows = await db.select().from(schema.ownerSettings);
  if (rows[0]) await db.update(schema.ownerSettings).set(values).where(eq(schema.ownerSettings.id, rows[0].id));
  else await db.insert(schema.ownerSettings).values(values);
  res.json({ ok: true });
}));

// ---- Stripe webhook -------------------------------------------------------
// Verifies Stripe's signature when STRIPE_WEBHOOK_SECRET is set; without
// it the endpoint rejects requests (payment verification still works
// through checkStripePayment, which re-reads the session from Stripe).
export async function stripeWebhookHandler(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  if (!secret) return res.status(400).json({ error: "Stripe webhook is not configured (STRIPE_WEBHOOK_SECRET)." });
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: "Stripe is not configured." });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const saleId = Number(session.metadata?.auctionfloor_sale_id || 0);
    if (saleId) {
      const saleRows = await db.select().from(schema.sales).where(eq(schema.sales.id, saleId));
      const sale = saleRows[0];
      if (sale && sale.stripeCheckoutSessionId === session.id && !sale.invoicePaidAt) {
        const listingRows = await db.select().from(schema.listings).where(eq(schema.listings.id, sale.listingId));
        const listing = listingRows[0];
        const expected = saleTotalDueCents(sale);
        if (session.payment_status === "paid" && session.amount_total === expected && listing) {
          await db.update(schema.sales).set({ stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null }).where(eq(schema.sales.id, sale.id));
          await applyVerifiedStripePayment(listing, sale);
        }
      }
    }
  }
  res.json({ received: true });
}
