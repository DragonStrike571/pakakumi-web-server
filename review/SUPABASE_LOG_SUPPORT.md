# Message to paste into Supabase support

Subject: Internal PgBouncer connection logs consume most of my Free log allowance

My Free project generates approximately 30 MB/day of Logs Ingest, close to the 1 GB monthly allowance. The app primarily uses PostgreSQL through a shared node-postgres/Drizzle pool. It does not use Supabase's Data REST API, Auth SDK or Storage SDK.

In a recent sample I counted 358 PgBouncer entries, 130 PostgREST entries and 49 PostgreSQL entries. The PgBouncer samples show successful internal service connections rather than failed application requests:

```text
postgres/pgbouncer@[::1]:... login attempt: db=postgres user=pgbouncer tls=TLSv1.3/... replication=no
postgres/pgbouncer@[::1]:... closing because: client close request (age=0s)
postgres/supabase_storage_admin@... login attempt: db=postgres user=supabase_storage_admin ...
postgres/supabase_storage_admin@127.0.0.1:5432 new connection to server ...
```

The local PgBouncer login/close pairs occur within a few milliseconds and recur regularly. Example times are 2026-10-12 22:55:26 UTC, 22:55:41 UTC and 22:56:56 UTC. I understand that entry counts alone do not establish their share of ingested bytes.

Read-only checks found PostgreSQL `log_connections=off`, `log_disconnections=off`, `log_duration=off`, `log_min_duration_statement=-1`, `pgaudit.log=none`, and `log_statement=ddl`. I have kept warning/error, lock-wait and very slow-query diagnostics. These PostgreSQL settings do not appear to suppress PgBouncer's own login/disconnection logs.

Please advise:

1. Which managed service generates the repeating local `pgbouncer` connections? Are these health checks or another internal task?
2. Is there a supported dashboard/API control to reduce or sample PgBouncer's successful connection/disconnection messages while keeping pooler errors?
3. Can provider-generated health-check/Storage-service logs be excluded from the customer's Logs Ingest quota, or can unused managed services be disabled?
4. Will disabling the unused Data API reduce PostgREST/pooler log ingestion, or does it only disable public API exposure?

Please use the project selected in this support request to check its source/byte breakdown. I can attach the full example log rows if needed.

---

This is a draft for you to send. Codex has not contacted Supabase. Do not include your database password, API secrets or Telegram token.
