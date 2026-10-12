import { config } from "dotenv";
import { Pool } from "pg";
import { migrateDatabase } from "../src/db/migrations.js";
config();
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000, options: "-c timezone=UTC" });
pool.on("error", error => console.error("Migration connection error:", error));
const client = await pool.connect();
try { await migrateDatabase(client); console.log("Database migrations applied successfully"); }
finally { client.release(); await pool.end(); }
