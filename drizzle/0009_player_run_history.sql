CREATE TABLE "player_run_batches" (
	"run_id" uuid NOT NULL,
	"batch" integer NOT NULL,
	"rounds" jsonb,
	"plays" jsonb NOT NULL,
	CONSTRAINT "player_run_batches_run_id_batch_pk" PRIMARY KEY("run_id","batch")
);
--> statement-breakpoint
CREATE TABLE "player_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"replay_of" uuid,
	"rounds_run_id" uuid NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"stop_reason" text,
	"settings" jsonb NOT NULL,
	"result" jsonb
);
--> statement-breakpoint
ALTER TABLE "player_run_batches" ADD CONSTRAINT "player_run_batches_run_id_player_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."player_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_runs" ADD CONSTRAINT "player_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "player_runs_user_started_idx" ON "player_runs" USING btree ("user_id","started_at" DESC NULLS LAST,"id" DESC NULLS LAST);