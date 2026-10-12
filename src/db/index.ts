import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15_000,
  query_timeout: 20_000,
  idle_in_transaction_session_timeout: 30_000,
  options: "-c timezone=UTC",
});

// Idle connections fail outside request promises. pg removes the failed client.
pool.on("error", (error) => {
  console.error("PostgreSQL idle connection failed; pool will reconnect:", error);
});

export const db = drizzle(pool, { schema });
export { pool };
