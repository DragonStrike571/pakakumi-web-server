CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_snapshots" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"active_signals" jsonb,
	"upcoming_opportunities" jsonb,
	"stats" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_play_config" (
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
CREATE TABLE "auto_play_opportunities" (
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
CREATE TABLE "bot_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"strategy_id" uuid NOT NULL,
	"credential_id" uuid,
	"encrypted_phone" text,
	"encrypted_password" text,
	"status" text NOT NULL,
	"initial_capital" numeric NOT NULL,
	"current_capital" numeric NOT NULL,
	"total_profit" numeric NOT NULL,
	"logs" jsonb,
	"current_step" integer DEFAULT 0,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"heartbeat_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "daily_stats" (
	"date" text PRIMARY KEY NOT NULL,
	"total_predictions" integer DEFAULT 0 NOT NULL,
	"total_hits" integer DEFAULT 0 NOT NULL,
	"total_misses" integer DEFAULT 0 NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pakakumi_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"phone" text NOT NULL,
	"password" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"amount" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"duration_paid_for" numeric NOT NULL,
	"reference" text NOT NULL,
	"next_verification_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payments_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "pending_signals" (
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
CREATE TABLE "rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"bust" numeric NOT NULL,
	"bust_id" text NOT NULL,
	"players_online" integer,
	"players_playing" integer,
	"total_amount_played" numeric,
	"total_amount_won" numeric,
	"total_amount_lost" numeric,
	"average_amount_played" numeric,
	"max_amount_played" numeric,
	"total_reserve_funds" numeric,
	"rounds_since_last_3000" integer,
	"gap_detected" boolean DEFAULT false NOT NULL,
	"metrics_complete" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "signal_history" (
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
CREATE TABLE "strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_stats" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"signals" integer DEFAULT 0 NOT NULL,
	"last_alert_round" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"chat_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"locked_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_deliveries_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "telegram_users" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"username" text,
	"expiry_timestamp" timestamp,
	"revoked_at" timestamp,
	"session_state" text DEFAULT 'command' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"password_hash" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'user' NOT NULL,
	"access_status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_play_config" ADD CONSTRAINT "auto_play_config_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_play_config" ADD CONSTRAINT "auto_play_config_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_play_config" ADD CONSTRAINT "auto_play_config_credential_id_pakakumi_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."pakakumi_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_play_opportunities" ADD CONSTRAINT "auto_play_opportunities_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_play_opportunities" ADD CONSTRAINT "auto_play_opportunities_session_id_bot_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."bot_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD CONSTRAINT "bot_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD CONSTRAINT "bot_sessions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD CONSTRAINT "bot_sessions_credential_id_pakakumi_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."pakakumi_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pakakumi_credentials" ADD CONSTRAINT "pakakumi_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_chat_id_telegram_users_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."telegram_users"("chat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_access" ADD CONSTRAINT "strategy_access_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_access" ADD CONSTRAINT "strategy_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_chat_id_telegram_users_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."telegram_users"("chat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_deliveries" ADD CONSTRAINT "telegram_deliveries_chat_id_telegram_users_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."telegram_users"("chat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auto_play_config_user_idx" ON "auto_play_config" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auto_play_opp_status_idx" ON "auto_play_opportunities" USING btree ("status");--> statement-breakpoint
CREATE INDEX "auto_play_opp_created_idx" ON "auto_play_opportunities" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "bot_sessions_user_idx" ON "bot_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bot_sessions_status_idx" ON "bot_sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_sessions_one_live_per_user_idx" ON "bot_sessions" USING btree ("user_id") WHERE "bot_sessions"."status" in ('pending', 'starting', 'active');--> statement-breakpoint
CREATE INDEX "pakakumi_credentials_user_idx" ON "pakakumi_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "payments_chat_id_idx" ON "payments" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "payments_reference_idx" ON "payments" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "created_at_idx" ON "rounds" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "bust_id_idx" ON "rounds" USING btree ("bust_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "signal_history_target_idx" ON "signal_history" USING btree ("target");--> statement-breakpoint
CREATE INDEX "signal_history_outcome_idx" ON "signal_history" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "signal_history_created_idx" ON "signal_history" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "strategies_user_idx" ON "strategies" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "strategy_access_strategy_idx" ON "strategy_access" USING btree ("strategy_id");--> statement-breakpoint
CREATE INDEX "strategy_access_user_idx" ON "strategy_access" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_access_strategy_user_unique" ON "strategy_access" USING btree ("strategy_id","user_id");--> statement-breakpoint
CREATE INDEX "support_tickets_chat_id_idx" ON "support_tickets" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "support_tickets_status_idx" ON "support_tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "telegram_delivery_due_idx" ON "telegram_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "telegram_users_session_idx" ON "telegram_users" USING btree ("session_state");--> statement-breakpoint
CREATE INDEX "email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "phone_idx" ON "users" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verifications" USING btree ("identifier");