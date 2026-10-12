CREATE TABLE "analysis_checkpoints" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"round_id" uuid NOT NULL,
	"round_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_checkpoints" ADD CONSTRAINT "analysis_checkpoints_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;