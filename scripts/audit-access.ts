import "dotenv/config";
import { pool } from "../src/db/index.js";
// Read-only: legitimate administrators and subscribers must be checked against trusted records.
try {
  const result = await pool.query(`SELECT id, email, role, access_status, created_at FROM users
    WHERE role <> 'user' OR access_status <> 'pending' ORDER BY created_at, id`);
  console.log(JSON.stringify({ reviewRequired: result.rows.length, accounts: result.rows }, null, 2));
} finally { await pool.end(); }
