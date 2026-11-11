// Smoke test for the AuctionFloor Render port.
// Requires a Postgres database (DATABASE_URL) and the server running
// (or it starts it itself via `npm run test:smoke` with TEST_PORT).
// Exercises: list -> bid (incl. min-bid rule) -> force end -> finalize
// -> fees/invoice -> access-code checkout -> delivery request/quote/
// agree (both sides) -> pickup confirmations -> payout gate (NOT
// released while the invoice is unpaid — no Stripe key in test).
// Stripe checkout creation is expected to fail with 503 here because
// no STRIPE_SECRET_KEY is set in the test environment; that is the
// intended behaviour, and it is asserted, not skipped silently.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const PORT = Number(process.env.TEST_PORT || 3101);
const BASE = `http://localhost:${PORT}`;
process.env.PORT = String(PORT);
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://auctionfloor:auctionfloor@localhost:5432/auctionfloor_test";
process.env.SESSION_SECRET = "test-session-secret-long-enough";
process.env.APP_URL = "http://localhost:3101";
delete process.env.STRIPE_SECRET_KEY;

let server;
async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not become healthy");
}
async function post(path, body, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, cookie: res.headers.get("set-cookie") };
}
const eq = (a, b, label) => assert.equal(a, b, `${label}: got ${a}, want ${b}`);

async function main() {
  server = spawn("node", ["server.js"], { cwd: new URL("..", import.meta.url).pathname, env: process.env, stdio: "pipe" });
  server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  try {
    await waitForHealth();
    console.log("health OK");

    // 1. Create a listing (no photo in the smoke test).
    // ZIP outside the 250-mile radius of 37406 must be rejected.
    const far = await post("/api/createListing", {
      year: 2012, make: "Jaguar", model: "XJ", trim: "Base", mileage: 120000,
      condition: "Not running", titleStatus: "Clean title", location: "Beverly Hills, CA", zipCode: "90210",
      description: "Smoke-test car. Does not run.", photo: null,
      sellerName: "Test Seller", sellerPhone: "4235550100", sellerEmail: "seller@example.com",
      startingPrice: 400, reservePrice: 0, durationHours: 1,
    });
    eq(far.status, 500, "out-of-radius ZIP rejected");
    const created = await post("/api/createListing", {
      year: 2012, make: "Jaguar", model: "XJ", trim: "Base", mileage: 120000,
      condition: "Not running", titleStatus: "Clean title", location: "Chattanooga, TN", zipCode: "37406",
      description: "Smoke-test car. Does not run.", photo: null,
      sellerName: "Test Seller", sellerPhone: "4235550100", sellerEmail: "seller@example.com",
      startingPrice: 400, reservePrice: 0, durationHours: 1,
    });
    eq(created.status, 200, "createListing status");
    const listingId = created.data.id;
    console.log("listing created:", listingId);

    // 2. Bid below the minimum must fail; a valid bid must succeed.
    const low = await post("/api/placeBid", { listingId, bidderName: "Buyer", bidderPhone: "4235550101", bidderEmail: "buyer@example.com", amount: 399 });
    eq(low.status, 500, "low bid rejected");
    const bid = await post("/api/placeBid", { listingId, bidderName: "Test Buyer", bidderPhone: "4235550101", bidderEmail: "buyer@example.com", amount: 800 });
    eq(bid.status, 200, "placeBid status");
    eq(bid.data.ok, true, "placeBid ok");

    // 3. Force the auction to end (test-only: move ends_at into the past
    //    directly in Postgres), then list to trigger finalization.
    const { Client } = await import("pg");
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query("UPDATE listings SET ends_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [listingId]);
    await client.end();

    const listed = await post("/api/listAuctions", { filter: "ended" });
    eq(listed.status, 200, "listAuctions status");
    const ended = listed.data.listings.find((l) => l.id === listingId);
    assert.ok(ended, "ended listing present");
    eq(ended.sale.status, "sold", "sale status");
    eq(ended.sale.amount, 800, "winning bid");
    eq(ended.sale.buyerFee, 40, "buyer fee 5% under $5,000");
    eq(ended.sale.processingFee, Math.round(840 * 100 * 0.029) + 30, "administrative fee 2.9% + $0.30");
    console.log("fees OK: buyer fee $40, administrative fee", ended.sale.processingFee, "cents");

    // 4. Get the access code from the DB (in production it arrives by
    //    text/email), then open the checkout with it.
    const client2 = new Client({ connectionString: process.env.DATABASE_URL });
    await client2.connect();
    const saleRow = (await client2.query("SELECT access_token, id FROM sales WHERE listing_id = $1", [listingId])).rows[0];
    await client2.end();
    const code = saleRow.access_token;
    assert.equal(code.length, 8, "access code is 8 chars");
    const checkout = await post("/api/getSaleCheckout", { accessCode: code });
    eq(checkout.status, 200, "getSaleCheckout status");
    eq(checkout.data.found, true, "checkout found");
    eq(checkout.data.totalDue, 800 + 40 + checkout.data.processingFee / 100, "invoice total");
    console.log("invoice total:", checkout.data.totalDue);

    // 5. Stripe checkout creation must fail cleanly with no key (503),
    //    never a live session.
    const stripeAttempt = await post("/api/createStripeCheckout", { accessCode: code });
    eq(stripeAttempt.status, 503, "createStripeCheckout without key is 503");

    // 6. Owner setup + login, then delivery request/quote/agree.
    const setup = await post("/api/owner/setup", { email: "owner@example.com", password: "test-password-123" });
    eq(setup.status, 200, "owner setup");
    const ownerCookie = setup.cookie;
    const delivery = await post("/api/requestDelivery", { accessCode: code, deliveryAddress: "100 Main St, Spencer, TN", deliveryNotes: "Gate code 1234" });
    eq(delivery.status, 200, "requestDelivery");
    eq(delivery.data.deliveryRequestedAt != null, true, "delivery requested");
    const quote = await post("/api/quoteDelivery", { saleId: saleRow.id, quoteCents: 15000 }, ownerCookie);
    eq(quote.status, 200, "quoteDelivery");
    const agreeBuyer = await post("/api/agreeToDelivery", { accessCode: code, role: "buyer" });
    eq(agreeBuyer.status, 200, "buyer agrees to delivery");
    eq(agreeBuyer.data.deliveryBuyerAgreedAt != null, true, "buyer agreement recorded");
    const agreeSeller = await post("/api/agreeToDelivery", { accessCode: code, role: "seller" });
    eq(agreeSeller.data.deliverySellerAgreedAt != null, true, "seller agreement recorded");
    console.log("delivery booked at $150.00 (both agreed)");

    // 7. Pickup confirmations by both sides — but the payout must NOT
    //    release because the invoice is unpaid (no Stripe key in test).
    await post("/api/confirmPickup", { accessCode: code, role: "buyer" });
    const after = await post("/api/confirmPickup", { accessCode: code, role: "seller" });
    eq(after.data.buyerPickupConfirmedAt != null, true, "buyer pickup confirmed");
    eq(after.data.sellerPickupConfirmedAt != null, true, "seller pickup confirmed");
    eq(after.data.payoutReleasedAt, null, "payout NOT released while invoice unpaid");
    console.log("payout gate OK: not released while invoice unpaid");

    // 8. Owner-only endpoints reject unauthenticated callers.
    const anon = await post("/api/listOwnerMessages", {});
    eq(anon.status, 403, "owner messages require login");
    const authed = await post("/api/listOwnerMessages", {}, ownerCookie);
    eq(authed.status, 200, "owner messages with login");
    assert.ok(authed.data.messages.length >= 1, "owner fee notice present");
    console.log("owner gating OK");

    console.log("\nSMOKE TEST PASSED");
  } finally {
    server?.kill();
  }
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  server?.kill();
  process.exit(1);
});
