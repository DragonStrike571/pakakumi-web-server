import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { migrateDatabase } from "./migrations.js";

async function applyOld(database: PGlite, count: number) {
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  await database.exec('CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)');
  for (const entry of journal.entries.slice(0, count)) {
    let sql = await readFile(`drizzle/${entry.tag}.sql`, "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    // Fixture for a database whose UUID conversion was performed manually.
    if (entry.idx === 1) sql = sql.replace('ALTER TABLE "users" ALTER COLUMN "id" SET DATA TYPE uuid;',
      'ALTER TABLE "users" ALTER COLUMN "id" DROP DEFAULT; ALTER TABLE "users" ALTER COLUMN "id" SET DATA TYPE uuid USING md5("id"::text)::uuid;');
    await database.exec(sql.replace(/--> statement-breakpoint/g, ""));
    await database.query('INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES ($1,$2)', [hash, entry.when]);
  }
}

test("fresh PostgreSQL bootstrap is complete and rerunning migrations preserves data", async () => {
  const database = new PGlite();
  try {
    await migrateDatabase(database);
    await database.exec("INSERT INTO users(id,name,email) VALUES ('a','A','a@test.invalid')");
    await migrateDatabase(database);
    assert.equal((await database.query('SELECT * FROM users')).rows.length, 1);
    assert.equal((await database.query('SELECT * FROM drizzle.__drizzle_migrations')).rows.length, 9);
    assert.equal((await database.query("SELECT column_name FROM information_schema.columns WHERE table_name='telegram_users' AND column_name='revoked_at'")).rows.length, 1);
  } finally { await database.close(); }
});

test("serial ID database upgrades without losing users", async () => {
  const database = new PGlite();
  try {
    await applyOld(database, 1);
    await database.exec("INSERT INTO users(name,email) VALUES ('Legacy','legacy@test.invalid')");
    await migrateDatabase(database);
    const [user] = (await database.query<{ id: string; name: string }>('SELECT id,name FROM users')).rows;
    assert.equal(user!.name, "Legacy");
    assert.match(user!.id, /^[0-9a-f-]{36}$/);
    await database.query("INSERT INTO sessions(id,token,expires_at,user_id) VALUES ('s','t',now()+interval '1 day',$1)", [user!.id]);
  } finally { await database.close(); }
});

test("UUID schema converts related keys together and keeps foreign keys", async () => {
  const database = new PGlite();
  try {
    await applyOld(database, 2);
    const id = "12345678-1234-1234-1234-123456789abc";
    await database.query("INSERT INTO users(id,name,email) VALUES ($1,'UUID','uuid@test.invalid')", [id]);
    await database.query("INSERT INTO sessions(id,token,expires_at,user_id) VALUES ('s','t',now()+interval '1 day',$1)", [id]);
    await migrateDatabase(database);
    assert.equal((await database.query<{ user_id: string }>('SELECT user_id FROM sessions')).rows[0]!.user_id, id);
    await assert.rejects(database.exec("INSERT INTO sessions(id,token,expires_at,user_id) VALUES ('bad','bad',now(),'missing')"), /foreign key/);
  } finally { await database.close(); }
});

test("untracked populated schema is refused with no partial changes", async () => {
  const database = new PGlite();
  try {
    await database.exec('CREATE TABLE users(id text); INSERT INTO users VALUES (\'keep\')');
    await assert.rejects(migrateDatabase(database), /Untracked existing schema/);
    assert.equal((await database.query('SELECT * FROM users')).rows.length, 1);
    assert.equal((await database.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name='drizzle'")).rows.length, 0);
  } finally { await database.close(); }
});

test("an existing installation gains the outbox and recovers one invite per paid user", async () => {
  const database = new PGlite();
  try {
    await migrateDatabase(database);
    await database.exec(`DROP TABLE analysis_checkpoints; DROP TABLE telegram_deliveries;
      ALTER TABLE payments DROP COLUMN next_verification_at; ALTER TABLE telegram_users DROP COLUMN revoked_at;`);
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
    await database.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= $1', [journal.entries[7].when]);
    await database.exec("INSERT INTO telegram_users(chat_id,expiry_timestamp) VALUES ('1',now()+interval '1 day'); INSERT INTO payments(chat_id,amount,duration_paid_for,reference,status) VALUES ('1',50,1,'paid','success')");
    await migrateDatabase(database); await migrateDatabase(database);
    const [job] = (await database.query<{ dedupe_key: string; status: string }>('SELECT * FROM telegram_deliveries')).rows;
    assert.equal(job!.dedupe_key, "payment:paid"); assert.equal(job!.status, "pending");
    assert.equal((await database.query('SELECT * FROM telegram_deliveries')).rows.length, 1);
  } finally { await database.close(); }
});
