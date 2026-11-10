// Runs drizzle/*.sql in order, tracking applied files in a
// schema_migrations table. Idempotent: every migration file is written
// to be safely re-runnable. Run automatically on server startup
// (server.js) and manually with `npm run migrate`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "drizzle");

export async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const applied = new Set((await pool.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    console.log(`Applying migration ${file}...`);
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
  }
  console.log("Migrations up to date.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
