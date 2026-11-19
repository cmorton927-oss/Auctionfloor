// Relist test for AuctionFloor.
// Requires a Postgres database (DATABASE_URL) and nothing else — same
// setup as test/smoke.mjs (it spawns the server itself). Exercises
// POST /api/relistListing (owner-only): refused while the auction is
// live, refused without an owner login, refused for a sold car;
// allowed for no-sale and reserve-not-met endings; copies the details
// and the photos to NEW files (deleting the original leaves the
// relist's photos intact); the new listing starts with 0 bids and a
// fresh clock. Cleans up its listings afterwards.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.TEST_PORT || 3102);
const BASE = `http://localhost:${PORT}`;
process.env.PORT = String(PORT);
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/auctionfloor_test";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
process.env.APP_URL = `http://localhost:${PORT}`;
process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "af-relist-uploads-"));
delete process.env.STRIPE_SECRET_KEY;

// 1x1 transparent PNG, used as the test photo.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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
async function post(pathname, body, cookie) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, cookie: res.headers.get("set-cookie") };
}
async function sql(query, params = []) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await client.query(query, params);
  } finally {
    await client.end();
  }
}
const eq = (a, b, label) => assert.equal(a, b, `${label}: got ${a}, want ${b}`);

async function main() {
  server = spawn("node", ["server.js"], { cwd: new URL("..", import.meta.url).pathname, env: process.env, stdio: "pipe" });
  server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  const createdIds = [];
  try {
    await waitForHealth();
    console.log("health OK");

    // Owner login: first run sets the owner up, later runs log in.
    let ownerCookie = null;
    const setup = await post("/api/owner/setup", { email: "owner@example.com", password: "test-password-123" });
    if (setup.status === 200) {
      ownerCookie = setup.cookie;
    } else {
      const login = await post("/api/owner/login", { email: "owner@example.com", password: "test-password-123" });
      eq(login.status, 200, "owner login");
      ownerCookie = login.cookie;
    }
    assert.ok(ownerCookie, "owner cookie present");
    console.log("owner login OK");

    // 1. Create listing A with photos, private seller, Runs & drives.
    const created = await post("/api/createListing", {
      year: 2012, make: "Chevrolet", model: "Silverado", trim: "LT", mileage: 260000,
      condition: "Runs & drives", titleStatus: "Clean title", location: "Palmer, TN", zipCode: "37365",
      description: "Relist-test truck. Runs and drives.", photo: null,
      photos: [
        { dataBase64: PNG_1X1, mimeType: "image/png" },
        { dataBase64: PNG_1X1, mimeType: "image/png" },
      ],
      sellerName: "Relist Seller", sellerPhone: "4235550199", sellerEmail: "relist-seller@example.com",
      privateSeller: true, noMechanicalIssuesConfirmed: true,
      startingPrice: 7000, reservePrice: 7000, buyNowPrice: 7000, durationHours: 72,
    });
    eq(created.status, 200, "createListing A status");
    const listingA = created.data.id;
    createdIds.push(listingA);
    console.log("listing A created:", listingA);

    // 2. Relist refused while live, and refused without owner login.
    const live = await post("/api/relistListing", { listingId: listingA, durationHours: 168, startingPrice: 7000, reservePrice: 0, buyNowPrice: 0 }, ownerCookie);
    eq(live.status, 500, "relist while live refused");
    assert.match(live.data.error || "", /still live/, "live refusal message");
    const anon = await post("/api/relistListing", { listingId: listingA, durationHours: 168, startingPrice: 7000, reservePrice: 0, buyNowPrice: 0 });
    eq(anon.status, 403, "relist without owner login refused");
    console.log("live + anonymous refusals OK");

    // 3. Force A to end with no bids; finalize records no_sale.
    await sql("UPDATE listings SET ends_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [listingA]);
    const listed = await post("/api/listAuctions", { filter: "ended" });
    eq(listed.status, 200, "listAuctions status");
    const endedA = listed.data.listings.find((l) => l.id === listingA);
    assert.ok(endedA, "ended listing A present");
    eq(endedA.sale.status, "no_sale", "A finalized as no_sale");
    const detailA = (await post("/api/getAuction", { id: listingA })).data.listing;
    eq(detailA.photos.length, 2, "A has 2 photos");

    // 4. Relist A with new prices; the new listing copies everything.
    const relisted = await post("/api/relistListing", { listingId: listingA, durationHours: 168, startingPrice: 500, reservePrice: 0, buyNowPrice: 900 }, ownerCookie);
    eq(relisted.status, 200, "relist A status");
    const listingB = relisted.data.id;
    assert.notEqual(listingB, listingA, "relist is a new listing");
    createdIds.push(listingB);
    const detailB = (await post("/api/getAuction", { id: listingB })).data.listing;
    eq(detailB.year, 2012, "year copied");
    eq(detailB.make, "Chevrolet", "make copied");
    eq(detailB.model, "Silverado", "model copied");
    eq(detailB.trim, "LT", "trim copied");
    eq(detailB.mileage, 260000, "mileage copied");
    eq(detailB.condition, "Runs & drives", "condition copied");
    eq(detailB.titleStatus, "Clean title", "title copied");
    eq(detailB.location, "Palmer, TN", "location copied");
    eq(detailB.zipCode, "37365", "ZIP copied");
    eq(detailB.description, "Relist-test truck. Runs and drives.", "description copied");
    eq(detailB.privateSeller, true, "private seller flag copied");
    eq(detailB.noMechanicalIssuesConfirmed, true, "no-issues confirmation copied");
    eq(detailB.startingPrice, 500, "new starting price");
    eq(detailB.reservePrice, null, "reserve cleared");
    eq(detailB.buyNowPrice, 900, "new Buy Now price");
    eq(detailB.bidCount, 0, "new listing starts with 0 bids");
    eq(detailB.isEnded, false, "new listing is live");
    const hoursLeft = (new Date(detailB.endsAt).getTime() - Date.now()) / 3600000;
    assert.ok(hoursLeft > 167 && hoursLeft < 169, `fresh 7-day clock (got ${hoursLeft.toFixed(2)}h)`);
    eq(detailB.photos.length, 2, "photos copied");
    assert.ok(!detailB.photos.some((p) => detailA.photos.includes(p)), "copied photos have distinct paths");
    const rowB = (await sql("SELECT seller_name, seller_phone, seller_email, private_seller, no_mechanical_issues_confirmed FROM listings WHERE id = $1", [listingB])).rows[0];
    eq(rowB.seller_name, "Relist Seller", "seller name copied");
    eq(rowB.seller_phone, "4235550199", "seller phone copied");
    eq(rowB.seller_email, "relist-seller@example.com", "seller email copied");
    const photoRes = await fetch(`${BASE}${detailB.photos[0]}`);
    eq(photoRes.status, 200, "relisted photo serves");
    console.log("relist copy OK: listing B =", listingB);

    // 5. Deleting the original must not break the relist's photos
    //    (copies, not shared paths).
    await post("/api/deleteListing", { id: listingA });
    const photoAfter = await fetch(`${BASE}${detailB.photos[0]}`);
    eq(photoAfter.status, 200, "relisted photo still serves after original deleted");
    console.log("photo independence OK");

    // 6. Sold cars can't be relisted.
    await sql("INSERT INTO verified_bidders (email) VALUES ('relist-buyer@example.com') ON CONFLICT (email) DO NOTHING");
    const createdC = await post("/api/createListing", {
      year: 2010, make: "Ford", model: "F-150", trim: "", mileage: 180000,
      condition: "Not running", titleStatus: "Clean title", location: "Chattanooga, TN", zipCode: "37406",
      description: "Relist-test sold car.", photo: null,
      sellerName: "Relist Seller", sellerPhone: "4235550199", sellerEmail: "relist-seller@example.com",
      startingPrice: 400, reservePrice: 0, buyNowPrice: 0, durationHours: 1,
    });
    const listingC = createdC.data.id;
    createdIds.push(listingC);
    const bidC = await post("/api/placeBid", { listingId: listingC, bidderName: "Relist Buyer", bidderPhone: "4235550101", bidderEmail: "relist-buyer@example.com", amount: 800 });
    eq(bidC.status, 200, "bid on C placed");
    eq(bidC.data.ok, true, "bid on C ok");
    await sql("UPDATE listings SET ends_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [listingC]);
    await post("/api/listAuctions", { filter: "ended" });
    const detailC = (await post("/api/getAuction", { id: listingC })).data.listing;
    eq(detailC.sale.status, "sold", "C finalized as sold");
    const soldRelist = await post("/api/relistListing", { listingId: listingC, durationHours: 168, startingPrice: 400, reservePrice: 0, buyNowPrice: 0 }, ownerCookie);
    eq(soldRelist.status, 500, "relist of sold car refused");
    assert.match(soldRelist.data.error || "", /already sold/, "sold refusal message");
    console.log("sold refusal OK");

    // 7. Reserve-not-met endings CAN be relisted.
    const createdD = await post("/api/createListing", {
      year: 2008, make: "Nissan", model: "Altima", trim: "", mileage: 150000,
      condition: "Runs, needs work", titleStatus: "Clean title", location: "Chattanooga, TN", zipCode: "37406",
      description: "Relist-test reserve car.", photo: null,
      sellerName: "Relist Seller", sellerPhone: "4235550199", sellerEmail: "relist-seller@example.com",
      startingPrice: 400, reservePrice: 1000, buyNowPrice: 0, durationHours: 1,
    });
    const listingD = createdD.data.id;
    createdIds.push(listingD);
    await post("/api/placeBid", { listingId: listingD, bidderName: "Relist Buyer", bidderPhone: "4235550101", bidderEmail: "relist-buyer@example.com", amount: 500 });
    await sql("UPDATE listings SET ends_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [listingD]);
    await post("/api/listAuctions", { filter: "ended" });
    const detailD = (await post("/api/getAuction", { id: listingD })).data.listing;
    eq(detailD.sale.status, "reserve_not_met", "D finalized as reserve_not_met");
    const relistedD = await post("/api/relistListing", { listingId: listingD, durationHours: 72, startingPrice: 400, reservePrice: 900, buyNowPrice: 0 }, ownerCookie);
    eq(relistedD.status, 200, "reserve_not_met relist allowed");
    createdIds.push(relistedD.data.id);
    const detailE = (await post("/api/getAuction", { id: relistedD.data.id })).data.listing;
    eq(detailE.bidCount, 0, "reserve relist starts with 0 bids");
    eq(detailE.reservePrice, 900, "reserve relist keeps new reserve");
    console.log("reserve_not_met relist OK");

    console.log("\nRELIST TEST PASSED");
  } finally {
    for (const id of createdIds) {
      await post("/api/deleteListing", { id }).catch(() => {});
    }
    fs.rmSync(process.env.UPLOADS_DIR, { recursive: true, force: true });
    server?.kill();
  }
}

main().catch((err) => {
  console.error("RELIST TEST FAILED:", err);
  server?.kill();
  process.exit(1);
});
