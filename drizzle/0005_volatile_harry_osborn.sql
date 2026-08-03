ALTER TABLE "rounds" ADD COLUMN IF NOT EXISTS "metrics_complete" boolean DEFAULT true NOT NULL;
