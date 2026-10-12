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
ALTER TABLE "payments" ADD COLUMN "next_verification_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_users" ADD COLUMN "revoked_at" timestamp;--> statement-breakpoint
ALTER TABLE "telegram_deliveries" ADD CONSTRAINT "telegram_deliveries_chat_id_telegram_users_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."telegram_users"("chat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_delivery_due_idx" ON "telegram_deliveries" USING btree ("status","next_attempt_at");
--> statement-breakpoint
-- Restore delivery for existing paid subscribers whose invite may have failed.
INSERT INTO "telegram_deliveries" ("dedupe_key", "chat_id", "kind")
SELECT 'payment:' || p.reference, p.chat_id, 'invite'
FROM (SELECT DISTINCT ON (chat_id) reference, chat_id FROM payments WHERE status = 'success' ORDER BY chat_id, created_at DESC) p
JOIN telegram_users u ON u.chat_id = p.chat_id
WHERE u.expiry_timestamp > now()
ON CONFLICT (dedupe_key) DO NOTHING;
