// Drizzle schema for AuctionFloor (Postgres / pg-core).
// Mirrors the original Muse artifact schema (server/src/schema.ts) plus
// owner_users / owner_sessions, which replace Muse viewer identity
// (ctx.viewer.isOwner) with a real owner login.
import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const listings = pgTable("listings", {
  id: serial("id").primaryKey(),
  year: integer("year").notNull(),
  make: text("make").notNull(),
  model: text("model").notNull(),
  trim: text("trim"),
  mileage: integer("mileage").notNull(),
  condition: text("condition").notNull(), // Runs & drives | Runs, needs work | Not running | Parts / salvage
  titleStatus: text("title_status").notNull(), // Clean title | Rebuilt / salvage title | No title — bill of sale | Lien / other
  location: text("location").notNull(),
  zipCode: text("zip_code"), // mandatory seller ZIP since migration 0013; must be within 250 miles of 37406
  description: text("description").notNull(),
  imageUrl: text("image_url"),
  imagePath: text("image_path"), // local file under UPLOADS_DIR, served at /uploads/<name>
  sellerName: text("seller_name").notNull(),
  sellerPhone: text("seller_phone"),
  sellerEmail: text("seller_email"),
  privateSeller: boolean("private_seller").notNull().default(false), // when true, public views show "Private seller"; only the winning buyer learns the real name
  noMechanicalIssuesConfirmed: boolean("no_mechanical_issues_confirmed").notNull().default(false), // seller confirms no mechanical issues; required when condition is "Runs & drives"
  startingPrice: integer("starting_price").notNull(),
  reservePrice: integer("reserve_price"),
  buyNowPrice: integer("buy_now_price"), // optional seller-set sell-now price; a buyer paying it ends the auction early
  endsAt: timestamp("ends_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const listingPhotos = pgTable("listing_photos", {
  id: serial("id").primaryKey(),
  listingId: integer("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  imagePath: text("image_path").notNull(), // local file under UPLOADS_DIR, served at /uploads/<name>
  position: integer("position").notNull().default(0), // 0 = main/cover photo shown on the listing card
});

export const bids = pgTable("bids", {
  id: serial("id").primaryKey(),
  listingId: integer("listing_id").notNull().references(() => listings.id),
  bidderName: text("bidder_name").notNull(),
  bidderPhone: text("bidder_phone"),
  bidderEmail: text("bidder_email"),
  bidderPrivate: boolean("bidder_private").notNull().default(false), // when true, public views show only the bidder's initials; the seller still sees the real name if they win
  amount: integer("amount").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const watches = pgTable("watches", {
  id: serial("id").primaryKey(),
  listingId: integer("listing_id").notNull().references(() => listings.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sales = pgTable("sales", {
  id: serial("id").primaryKey(),
  listingId: integer("listing_id").notNull().unique().references(() => listings.id),
  status: text("status").notNull(), // sold | no_sale | reserve_not_met
  winnerName: text("winner_name"),
  winnerPhone: text("winner_phone"),
  winnerEmail: text("winner_email"),
  amount: integer("amount"),
  buyerFee: integer("buyer_fee"),
  sellerFee: integer("seller_fee"),
  processingFee: integer("processing_fee"), // cents
  accessToken: text("access_token"),
  invoiceSentAt: timestamp("invoice_sent_at"),
  invoicePaidAt: timestamp("invoice_paid_at"),
  buyerPickupConfirmedAt: timestamp("buyer_pickup_confirmed_at"),
  sellerPickupConfirmedAt: timestamp("seller_pickup_confirmed_at"),
  payoutReleasedAt: timestamp("payout_released_at"),
  deliveryRequestedAt: timestamp("delivery_requested_at"),
  deliveryAddress: text("delivery_address"),
  deliveryNotes: text("delivery_notes"),
  deliveryQuoteCents: integer("delivery_quote_cents"),
  deliveryQuotedAt: timestamp("delivery_quoted_at"),
  deliveryBuyerAgreedAt: timestamp("delivery_buyer_agreed_at"),
  deliverySellerAgreedAt: timestamp("delivery_seller_agreed_at"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  stripeCheckoutUrl: text("stripe_checkout_url"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripePaymentStatus: text("stripe_payment_status").default("not_started"), // not_started | creating | open | paid | expired | failed
  stripeLivemode: boolean("stripe_livemode"),
  stripeCheckoutCreatedAt: timestamp("stripe_checkout_created_at"),
  stripeLastCheckedAt: timestamp("stripe_last_checked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  listingId: integer("listing_id").notNull().references(() => listings.id),
  saleId: integer("sale_id").references(() => sales.id),
  recipientRole: text("recipient_role").notNull(), // buyer | seller | owner
  recipientName: text("recipient_name").notNull(),
  recipientPhone: text("recipient_phone"),
  recipientEmail: text("recipient_email"),
  body: text("body").notNull(),
  deliveryChannel: text("delivery_channel").notNull().default("in_app"), // in_app | sms | email
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const ownerSettings = pgTable("owner_settings", {
  id: serial("id").primaryKey(),
  ownerName: text("owner_name").notNull(),
  ownerPhone: text("owner_phone").notNull(),
  ownerEmail: text("owner_email").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Owner login (replaces Muse viewer identity). The first owner account is
// created through POST /api/owner/setup, which only works while no owner
// user exists yet; after that, login is email + password.
export const ownerUsers = pgTable("owner_users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const ownerSessions = pgTable("owner_sessions", {
  id: serial("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  ownerUserId: integer("owner_user_id").notNull().references(() => ownerUsers.id),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const alertSubscribers = pgTable("alert_subscribers", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  token: text("token").notNull().unique(), // per-recipient unsubscribe token
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  unsubscribedAt: timestamp("unsubscribed_at"),
});

// Bidders verified by the one-time $10 refundable deposit (manual-capture
// Checkout Session — authorized, never captured). One row per email;
// once verified, the bidder never deposits again.
export const verifiedBidders = pgTable("verified_bidders", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  verifiedAt: timestamp("verified_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// "See my bids" lookup codes: a 6-digit code emailed to the address the
// bidder bid with, proving the email is theirs. Expires after 15 minutes;
// a new request replaces any older code for that email. No accounts.
export const bidLookupCodes = pgTable("bid_lookup_codes", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  code: text("code").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
