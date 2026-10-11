ALTER TYPE "public"."account_kind" ADD VALUE 'league_entitlement_escrow' BEFORE 'treasury';--> statement-breakpoint
CREATE TABLE "base_league_entitlements" (
	"week" date NOT NULL,
	"base_id" uuid NOT NULL,
	"tier" "league" NOT NULL,
	"trophies" integer NOT NULL,
	"keep_amount" bigint NOT NULL,
	"paid_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_league_entitlements_week_base_id_pk" PRIMARY KEY("week","base_id"),
	CONSTRAINT "base_league_entitlements_trophies_nonnegative_ck" CHECK ("base_league_entitlements"."trophies" >= 0),
	CONSTRAINT "base_league_entitlements_keep_nonnegative_ck" CHECK ("base_league_entitlements"."keep_amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "base_league_entitlements" ADD CONSTRAINT "base_league_entitlements_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "base_league_entitlements_pending_idx" ON "base_league_entitlements" USING btree ("paid_at","last_attempt_at","week");