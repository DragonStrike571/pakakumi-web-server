import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export interface MigrationClient { query(sql: string, params?: any[]): Promise<{ rows: any[] }> }
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const BOOTSTRAP_COUNT = 8; // Snapshot includes migrations 0000 through 0007.

export async function migrateDatabase(client: MigrationClient, directory = resolve("drizzle")) {
  const journal = JSON.parse(await readFile(resolve(directory, "meta/_journal.json"), "utf8"));
  const migrations = await Promise.all(journal.entries.map(async (entry: { tag: string; when: number; idx: number }) => {
    const sql = await readFile(resolve(directory, `${entry.tag}.sql`), "utf8");
    return { ...entry, sql, hash: createHash("sha256").update(sql).digest("hex") };
  }));
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(746312091)");
    await client.query('CREATE SCHEMA IF NOT EXISTS drizzle');
    await client.query('CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)');
    const applied = (await client.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    for (let i = 0; i < applied.length; i++) {
      if (!migrations[i] || Number(applied[i].created_at) !== migrations[i].when || applied[i].hash !== migrations[i].hash) {
        throw new Error("Migration history differs from the checked-in journal; inspect before migrating");
      }
    }
    if (!applied.length) {
      const tables = (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows;
      if (tables.length) throw new Error("Untracked existing schema: inspect and use db:baseline before migrating; no changes were applied");
      const sqlFiles = (await readdir(resolve(directory, "bootstrap"))).filter(file => file.endsWith(".sql"));
      if (sqlFiles.length !== 1) throw new Error("Fresh database bootstrap must contain exactly one SQL snapshot");
      const sqlFile = sqlFiles[0]!;
      const bootstrap = await readFile(resolve(directory, "bootstrap", sqlFile), "utf8");
      for (const statement of bootstrap.split("--> statement-breakpoint")) if (statement.trim()) await client.query(statement);
      for (const migration of migrations.slice(0, BOOTSTRAP_COUNT)) await client.query(
        'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1,$2)', [migration.hash, migration.when]);
    }
    const start = applied.length || BOOTSTRAP_COUNT;
    for (const migration of migrations.slice(start)) {
      let migrationSql = migration.sql;
      let foreignKeys: { table_name: string; conname: string; definition: string }[] = [];
      // Preserve historical files/hashes while correcting their execution on older schemas.
      if (migration.idx === 1) migrationSql = migrationSql.replace(
        'ALTER TABLE "users" ALTER COLUMN "id" SET DATA TYPE uuid;',
        'ALTER TABLE "users" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint\nALTER TABLE "users" ALTER COLUMN "id" SET DATA TYPE uuid USING md5("id"::text)::uuid;');
      if (migration.idx === 2) {
        foreignKeys = (await client.query(`SELECT c.conname, t.relname AS table_name, pg_get_constraintdef(c.oid) AS definition
          FROM pg_constraint c JOIN pg_class t ON c.conrelid=t.oid WHERE c.contype='f' AND c.confrelid='public.users'::regclass`)).rows;
        for (const fk of foreignKeys) await client.query(`ALTER TABLE public.${quote(fk.table_name)} DROP CONSTRAINT ${quote(fk.conname)}`);
        await client.query('ALTER TABLE "users" ALTER COLUMN "id" DROP DEFAULT');
      }
      for (const statement of migrationSql.split("--> statement-breakpoint")) if (statement.trim()) await client.query(statement);
      for (const fk of foreignKeys) await client.query(`ALTER TABLE public.${quote(fk.table_name)} ADD CONSTRAINT ${quote(fk.conname)} ${fk.definition}`);
      await client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1,$2)', [migration.hash, migration.when]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}
