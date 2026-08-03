CREATE TABLE IF NOT EXISTS "analysis_snapshots" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"active_signals" jsonb,
	"upcoming_opportunities" jsonb,
	"stats" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auto_play_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"strategy_id" uuid,
	"credential_id" uuid,
	"max_loss_per_play" numeric,
	"max_daily_loss" numeric,
	"capital_percentage" real DEFAULT 5 NOT NULL,
	"cooldown_minutes" integer DEFAULT 30 NOT NULL,
	"min_cluster_size" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auto_play_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_targets" jsonb NOT NULL,
	"selected_target" real NOT NULL,
	"median_target" real NOT NULL,
	"cluster_size" integer NOT NULL,
	"avg_confidence" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claimed_by" text,
	"session_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_stats" (
	"date" text PRIMARY KEY NOT NULL,
	"total_predictions" integer DEFAULT 0 NOT NULL,
	"total_hits" integer DEFAULT 0 NOT NULL,
	"total_misses" integer DEFAULT 0 NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pakakumi_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"phone" text NOT NULL,
	"password" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"amount" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"duration_paid_for" numeric NOT NULL,
	"reference" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payments_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"target" real NOT NULL,
	"confidence" integer NOT NULL,
	"rounds_elapsed" integer DEFAULT 0 NOT NULL,
	"max_lifespan" integer NOT NULL,
	"cooldown_expiry" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signal_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target" real NOT NULL,
	"confidence" integer NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"expected_rounds_remaining" integer,
	"actual_rounds_to_hit" integer,
	"bust_value" real,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_stats" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"signals" integer DEFAULT 0 NOT NULL,
	"last_alert_round" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_users" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"username" text,
	"expiry_timestamp" timestamp,
	"session_state" text DEFAULT 'command' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD COLUMN IF NOT EXISTS "credential_id" uuid;--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD COLUMN IF NOT EXISTS "encrypted_phone" text;--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD COLUMN IF NOT EXISTS "encrypted_password" text;--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "access_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auto_play_config_user_id_users_id_fk') THEN ALTER TABLE "auto_play_config" ADD CONSTRAINT "auto_play_config_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auto_play_config_strategy_id_strategies_id_fk') THEN ALTER TABLE "auto_play_config" ADD CONSTRAINT "auto_play_config_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auto_play_config_credential_id_pakakumi_credentials_id_fk') THEN ALTER TABLE "auto_play_config" ADD CONSTRAINT "auto_play_config_credential_id_pakakumi_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."pakakumi_credentials"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auto_play_opportunities_claimed_by_users_id_fk') THEN ALTER TABLE "auto_play_opportunities" ADD CONSTRAINT "auto_play_opportunities_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auto_play_opportunities_session_id_bot_sessions_id_fk') THEN ALTER TABLE "auto_play_opportunities" ADD CONSTRAINT "auto_play_opportunities_session_id_bot_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."bot_sessions"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pakakumi_credentials_user_id_users_id_fk') THEN ALTER TABLE "pakakumi_credentials" ADD CONSTRAINT "pakakumi_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_chat_id_telegram_users_chat_id_fk') THEN ALTER TABLE "payments" ADD CONSTRAINT "payments_chat_id_telegram_users_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."telegram_users"("chat_id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_tickets_chat_id_telegram_users_chat_id_fk') THEN ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_chat_id_telegram_users_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."telegram_users"("chat_id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auto_play_config_user_idx" ON "auto_play_config" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auto_play_opp_status_idx" ON "auto_play_opportunities" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auto_play_opp_created_idx" ON "auto_play_opportunities" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pakakumi_credentials_user_idx" ON "pakakumi_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_chat_id_idx" ON "payments" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_reference_idx" ON "payments" USING btree ("reference");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_history_target_idx" ON "signal_history" USING btree ("target");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_history_outcome_idx" ON "signal_history" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_history_created_idx" ON "signal_history" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_chat_id_idx" ON "support_tickets" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_status_idx" ON "support_tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_users_session_idx" ON "telegram_users" USING btree ("session_state");--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bot_sessions_credential_id_pakakumi_credentials_id_fk') THEN ALTER TABLE "bot_sessions" ADD CONSTRAINT "bot_sessions_credential_id_pakakumi_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."pakakumi_credentials"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bot_sessions_one_live_per_user_idx" ON "bot_sessions" USING btree ("user_id") WHERE "bot_sessions"."status" in ('pending', 'starting', 'active');
