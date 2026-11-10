// Postgres pool + Drizzle client. DATABASE_URL is required in production
// (Render injects it from the Render Postgres service).
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. See .env.example / README.");
}
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});
export const db = drizzle(pool, { schema });
