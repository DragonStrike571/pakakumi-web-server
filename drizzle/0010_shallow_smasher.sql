ALTER TABLE "public"."player_run_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."player_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "public"."player_runs", "public"."player_run_batches" FROM PUBLIC;
--> statement-breakpoint
-- Only the application database connection needs access to saved runs.
DO $$
DECLARE api_role text;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.player_runs, public.player_run_batches FROM %I', api_role);
  END LOOP;
END $$;
