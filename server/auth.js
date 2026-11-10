// Owner auth: email + password login, session cookie.
// Passwords are hashed with bcryptjs. Sessions are random tokens stored
// hashed in owner_sessions, 30 days. The FIRST owner account is created
// via POST /api/owner/setup, which only works while no owner user exists.
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "./db.js";
import * as schema from "./schema.js";

export const OWNER_COOKIE = "af_owner_session";
const SESSION_DAYS = 30;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function ownerExists() {
  const rows = await db.select({ id: schema.ownerUsers.id }).from(schema.ownerUsers).limit(1);
  return rows.length > 0;
}

export async function createFirstOwner(email, password) {
  if (await ownerExists()) throw new Error("An owner account already exists.");
  const passwordHash = await bcrypt.hash(password, 12);
  const inserted = await db.insert(schema.ownerUsers).values({ email: email.toLowerCase(), passwordHash }).returning({ id: schema.ownerUsers.id });
  return inserted[0];
}

export async function loginOwner(email, password) {
  const rows = await db.select().from(schema.ownerUsers).where(eq(schema.ownerUsers.email, email.toLowerCase()));
  const user = rows[0];
  if (!user) throw new Error("Invalid email or password.");
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new Error("Invalid email or password.");
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await db.insert(schema.ownerSessions).values({ tokenHash: hashToken(token), ownerUserId: user.id, expiresAt });
  return { token, expiresAt, user };
}

export async function logoutOwner(token) {
  if (!token) return;
  await db.delete(schema.ownerSessions).where(eq(schema.ownerSessions.tokenHash, hashToken(token)));
}

export async function ownerFromRequest(req) {
  const token = req.cookies?.[OWNER_COOKIE];
  if (!token) return null;
  const rows = await db
    .select()
    .from(schema.ownerSessions)
    .where(and(eq(schema.ownerSessions.tokenHash, hashToken(token)), gt(schema.ownerSessions.expiresAt, new Date())));
  const session = rows[0];
  if (!session) return null;
  const users = await db.select().from(schema.ownerUsers).where(eq(schema.ownerUsers.id, session.ownerUserId));
  return users[0] ?? null;
}

export function ownerCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
  };
}
