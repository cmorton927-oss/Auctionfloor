// Alert-subscriber list test for AuctionFloor.
// Requires a Postgres database (DATABASE_URL) and nothing else — same
// setup as test/smoke.mjs (it spawns the server itself). Exercises
// POST /api/alertSubscribers (owner-only): refused without an owner
// login; with a login returns every subscriber (newest first) with
// email, active flag, signup date and unsubscribe date — and never the
// per-recipient unsubscribe token. Cleans up its subscriber rows
// afterwards.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.TEST_PORT || 3103);
const BASE = `http://localhost:${PORT}`;
process.env.PORT = String(PORT);
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/auctionfloor_test";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
process.env.APP_URL = `http://localhost:${PORT}`;
process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "af-alert-subs-uploads-"));
delete process.env.STRIPE_SECRET_KEY;

const EMAIL_A = "alert-test-a@example.com";
const EMAIL_B = "alert-test-b@example.com";

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

    // Start clean: remove any leftovers from an earlier interrupted run.
    await sql("DELETE FROM alert_subscribers WHERE email IN ($1, $2)", [EMAIL_A, EMAIL_B]);

    // 1. Subscribe two addresses.
    const subA = await post("/api/subscribeAlerts", { email: EMAIL_A });
    eq(subA.status, 200, "subscribe A status");
    eq(subA.data.ok, true, "subscribe A ok");
    const subB = await post("/api/subscribeAlerts", { email: EMAIL_B });
    eq(subB.status, 200, "subscribe B status");
    console.log("subscribed A and B");

    // 2. List refused without an owner login.
    const anon = await post("/api/alertSubscribers", {});
    eq(anon.status, 403, "list without owner login refused");

    // 3. List as owner: both present, active, newest first, no tokens.
    const listed = await post("/api/alertSubscribers", {}, ownerCookie);
    eq(listed.status, 200, "list as owner status");
    const rows = listed.data.subscribers;
    assert.ok(Array.isArray(rows), "subscribers is an array");
    const mine = rows.filter((r) => r.email === EMAIL_A || r.email === EMAIL_B);
    eq(mine.length, 2, "both test subscribers listed");
    eq(mine[0].email, EMAIL_B, "newest first");
    for (const r of mine) {
      eq(r.active, true, `${r.email} active`);
      assert.ok(r.createdAt, `${r.email} has createdAt`);
      eq(r.unsubscribedAt, null, `${r.email} unsubscribedAt null`);
      assert.ok(!("token" in r), `${r.email} has no token field`);
    }
    console.log("owner list OK, no tokens exposed");

    // 4. Unsubscribe A via its token, then re-list: A inactive with a
    // date, B still active.
    const tokenRows = await sql("SELECT token FROM alert_subscribers WHERE email = $1", [EMAIL_A]);
    const token = tokenRows.rows[0].token;
    const unsub = await fetch(`${BASE}/api/unsubscribeAlerts?token=${token}`);
    eq(unsub.status, 200, "unsubscribe A status");
    const listed2 = await post("/api/alertSubscribers", {}, ownerCookie);
    const rows2 = listed2.data.subscribers;
    const a2 = rows2.find((r) => r.email === EMAIL_A);
    const b2 = rows2.find((r) => r.email === EMAIL_B);
    eq(a2.active, false, "A inactive after unsubscribe");
    assert.ok(a2.unsubscribedAt, "A has unsubscribedAt");
    eq(b2.active, true, "B still active");
    assert.ok(!("token" in a2) && !("token" in b2), "still no token field");
    console.log("unsubscribe reflected in list OK");

    console.log("\nALERT-SUBSCRIBER LIST TEST PASSED");
  } finally {
    await sql("DELETE FROM alert_subscribers WHERE email IN ($1, $2)", [EMAIL_A, EMAIL_B]).catch(() => {});
    fs.rmSync(process.env.UPLOADS_DIR, { recursive: true, force: true });
    server?.kill();
  }
}

main().catch((err) => {
  console.error("ALERT-SUBSCRIBER LIST TEST FAILED:", err);
  server?.kill();
  process.exit(1);
});
