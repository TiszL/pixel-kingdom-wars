ALTER TABLE "item_listings" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
UPDATE "item_listings" SET "idempotency_key" = 'legacy:' || "id"::text WHERE "idempotency_key" IS NULL;--> statement-breakpoint
ALTER TABLE "item_listings" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "item_listings" ADD CONSTRAINT "item_listings_idempotency_key_unique" UNIQUE("idempotency_key");
