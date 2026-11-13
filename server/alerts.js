// New-listing email alerts for AuctionFloor.
// A visitor signs up with just an email address (no account). Every time a
// listing is created, each active subscriber gets one plain-text email.
// Sending uses the same SendGrid wiring as sale notifications (notify.js):
// SENDGRID_API_KEY + EMAIL_FROM env vars. Until those are set, alerts are
// skipped (never stored, never blocking) and notifyNewListing reports it.
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import * as schema from "./schema.js";
import { emailConfigured, sendEmail } from "./notify.js";

const APP_URL = (process.env.APP_URL || "https://auction423.com").replace(/\/$/, "");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validAlertEmail(email) {
  return EMAIL_RE.test(String(email ?? "").trim());
}

// Subscribe (or re-activate) an address. Returns { ok, alreadySubscribed }.
export async function subscribeAlert(rawEmail) {
  const email = String(rawEmail ?? "").trim().toLowerCase();
  if (!validAlertEmail(email)) throw new Error("Enter a valid email address.");
  const existing = await db.select().from(schema.alertSubscribers).where(eq(schema.alertSubscribers.email, email)).limit(1);
  if (existing.length) {
    if (existing[0].active) return { ok: true, alreadySubscribed: true };
    await db.update(schema.alertSubscribers).set({ active: true, unsubscribedAt: null }).where(eq(schema.alertSubscribers.id, existing[0].id));
    return { ok: true, alreadySubscribed: false };
  }
  await db.insert(schema.alertSubscribers).values({ email, token: crypto.randomBytes(16).toString("hex") });
  return { ok: true, alreadySubscribed: false };
}

// Unsubscribe by token. Returns true when a subscriber was found.
export async function unsubscribeAlert(token) {
  const rows = await db.select().from(schema.alertSubscribers).where(eq(schema.alertSubscribers.token, String(token ?? ""))).limit(1);
  if (!rows.length) return false;
  await db.update(schema.alertSubscribers).set({ active: false, unsubscribedAt: new Date() }).where(eq(schema.alertSubscribers.id, rows[0].id));
  return true;
}

function alertBody(listing, token) {
  const title = `${listing.year} ${listing.make} ${listing.model}${listing.trim ? ` ${listing.trim}` : ""}`;
  const lines = [
    `New on AuctionFloor: ${title}`,
    ``,
    `Starting bid: $${listing.startingPrice}`,
    listing.buyNowPrice ? `Buy Now: $${listing.buyNowPrice}` : null,
    `Condition: ${listing.condition}`,
    `Location: ${listing.location}${listing.zipCode ? ` ${listing.zipCode}` : ""}`,
    `Mileage: ${Number(listing.mileage).toLocaleString("en-US")} miles`,
    ``,
    `See it and bid: ${APP_URL}/listing/${listing.id}`,
    ``,
    `You're getting this because you signed up for new-listing alerts on AuctionFloor.`,
    `Stop these emails: ${APP_URL}/api/unsubscribeAlerts?token=${token}`,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

// Fire-and-forget from createListing: never throws, never blocks the sale.
export async function notifyNewListing(listing) {
  try {
    if (!emailConfigured) {
      console.log("new-listing alert skipped: email not configured (SENDGRID_API_KEY / EMAIL_FROM)");
      return { sent: 0, skipped: true };
    }
    const subs = await db.select().from(schema.alertSubscribers).where(eq(schema.alertSubscribers.active, true));
    if (!subs.length) return { sent: 0, skipped: false };
    const title = `${listing.year} ${listing.make} ${listing.model}`;
    let sent = 0;
    for (const sub of subs) {
      const ok = await sendEmail(sub.email, `New on AuctionFloor: ${title} — ${listing.location}`, alertBody(listing, sub.token));
      if (ok) sent += 1;
    }
    console.log(`new-listing alert: ${sent}/${subs.length} sent for listing ${listing.id}`);
    return { sent, skipped: false };
  } catch (err) {
    console.error("new-listing alert failed (listing unaffected):", err.message);
    return { sent: 0, skipped: false, error: err.message };
  }
}
