// Notifications: in-app Messages are ALWAYS written to the database.
// Email (SendGrid) and SMS (Twilio) are pluggable providers configured
// purely by environment variables — no credentials in code. If a provider
// key is absent, that channel's copies are stored in the messages table
// with sent_at left empty ("queued") and the sale is NEVER blocked by
// a missing provider. Sending is fire-and-forget: a provider failure
// leaves the copy queued, it does not fail the request that created it.
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import * as schema from "./schema.js";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_FROM || "";

export const emailConfigured = Boolean(SENDGRID_API_KEY && EMAIL_FROM);
export const smsConfigured = Boolean(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);

export async function sendEmail(to, subject, body) {
  if (!emailConfigured) return false;
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }], subject }],
      from: { email: EMAIL_FROM },
      content: [{ type: "text/plain", value: body }],
    }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch { /* ignore */ }
    console.error(`SendGrid send failed: HTTP ${res.status} to ${to}: ${detail.slice(0, 500)}`);
  }
  return res.ok;
}

async function sendSms(to, body) {
  if (!smsConfigured) return false;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  return res.ok;
}

// Try to deliver one stored sms/email message row; stamp sent_at on success.
// Runs in the background — callers must not await it on the hot path.
export async function attemptDelivery(messageRow) {
  try {
    let ok = false;
    if (messageRow.deliveryChannel === "email" && messageRow.recipientEmail) {
      ok = await sendEmail(messageRow.recipientEmail, messageRow.subject || "AuctionFloor", messageRow.body);
    } else if (messageRow.deliveryChannel === "sms" && messageRow.recipientPhone) {
      ok = await sendSms(messageRow.recipientPhone, messageRow.body);
    }
    if (ok) {
      await db.update(schema.messages).set({ sentAt: new Date() }).where(eq(schema.messages.id, messageRow.id));
    }
  } catch (err) {
    console.error("notification delivery failed (queued):", err.message);
  }
}

// Write in-app copies + sms/email copies for a sale event, then attempt
// delivery of the sms/email copies in the background.
// entries: [{ role, name, phone, email, body }]
// subject: used for email copies (stored on the row as a non-persisted
// field here — the subject is kept in memory for the send attempt).
export async function notifySaleParties(listing, sale, subject, entries) {
  const inApp = entries.map((e) => ({
    listingId: listing.id,
    saleId: sale.id,
    recipientRole: e.role,
    recipientName: e.name,
    recipientPhone: e.phone ?? null,
    recipientEmail: e.email ?? null,
    body: e.body,
    deliveryChannel: "in_app",
    sentAt: new Date(),
  }));
  await db.insert(schema.messages).values(inApp);

  const dispatches = [];
  for (const e of entries) {
    if (e.phone) dispatches.push({ ...e, channel: "sms" });
    if (e.email) dispatches.push({ ...e, channel: "email" });
  }
  if (!dispatches.length) return;
  const inserted = await db
    .insert(schema.messages)
    .values(
      dispatches.map((d) => ({
        listingId: listing.id,
        saleId: sale.id,
        recipientRole: d.role,
        recipientName: d.name,
        recipientPhone: d.phone ?? null,
        recipientEmail: d.email ?? null,
        body: d.body,
        deliveryChannel: d.channel,
      })),
    )
    .returning();
  // Fire-and-forget: do not block the sale flow on providers.
  for (const row of inserted) {
    attemptDelivery({ ...row, subject }).catch(() => {});
  }
}

export async function getOwnerSettingsRow() {
  const rows = await db.select().from(schema.ownerSettings).limit(1);
  return rows[0] ?? null;
}

// Build buyer/seller/owner notify entries from a sale + listing, with the
// three per-role message bodies.
export async function buyerSellerOwnerEntries(listing, sale, bodies) {
  const owner = await getOwnerSettingsRow();
  return [
    { role: "buyer", name: sale.winnerName ?? "Buyer", phone: sale.winnerPhone ?? null, email: sale.winnerEmail ?? null, body: bodies.buyer },
    { role: "seller", name: listing.sellerName, phone: listing.sellerPhone ?? null, email: listing.sellerEmail ?? null, body: bodies.seller },
    { role: "owner", name: owner?.ownerName ?? "Marketplace owner", phone: owner?.ownerPhone ?? null, email: owner?.ownerEmail ?? null, body: bodies.owner },
  ];
}
