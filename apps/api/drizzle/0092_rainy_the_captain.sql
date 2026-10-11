CREATE TABLE "alpha_invite_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"created_by_wallet" text NOT NULL,
	"requested_count" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alpha_invite_batches_count_ck" CHECK ("alpha_invite_batches"."requested_count" BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "alpha_invite_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"code" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"redeemed_wallet" text,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alpha_invite_codes_code_unique" UNIQUE("code"),
	CONSTRAINT "alpha_invite_codes_ordinal_ck" CHECK ("alpha_invite_codes"."ordinal" BETWEEN 0 AND 99),
	CONSTRAINT "alpha_invite_codes_shape_ck" CHECK ("alpha_invite_codes"."code" ~ '^[A-Z2-7]{26}$'),
	CONSTRAINT "alpha_invite_codes_redemption_pair_ck" CHECK (("alpha_invite_codes"."redeemed_wallet" IS NULL) = ("alpha_invite_codes"."redeemed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "alpha_invite_codes" ADD CONSTRAINT "alpha_invite_codes_batch_id_alpha_invite_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."alpha_invite_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alpha_invite_batches_creator_idem_uq" ON "alpha_invite_batches" USING btree ("created_by_wallet","idempotency_key");--> statement-breakpoint
CREATE INDEX "alpha_invite_batches_created_idx" ON "alpha_invite_batches" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alpha_invite_codes_batch_ordinal_uq" ON "alpha_invite_codes" USING btree ("batch_id","ordinal");--> statement-breakpoint
CREATE INDEX "alpha_invite_codes_created_idx" ON "alpha_invite_codes" USING btree ("created_at");