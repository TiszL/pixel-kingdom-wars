CREATE TABLE "item_market_cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_wallet" text NOT NULL,
	"request_key" text NOT NULL,
	"listing_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"source_base_id" uuid,
	"price_lamports" bigint NOT NULL,
	"expected_status" text NOT NULL,
	"expected_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"resolved_at" timestamp with time zone,
	"refusal_code" text,
	"settled_reference" text,
	"settled_tx_signature" text,
	"settled_buyer" text,
	"settled_buyer_base_id" uuid,
	CONSTRAINT "item_market_cancellation_consent_ck" CHECK ("item_market_cancellations"."price_lamports" > 0 AND (
    ("item_market_cancellations"."expected_status" = 'active' AND "item_market_cancellations"."expected_reference" IS NULL)
    OR ("item_market_cancellations"."expected_status" = 'reserved' AND "item_market_cancellations"."expected_reference" IS NOT NULL))),
	CONSTRAINT "item_market_cancellation_state_ck" CHECK (
    ("item_market_cancellations"."state" = 'pending' AND "item_market_cancellations"."resolved_at" IS NULL AND "item_market_cancellations"."refusal_code" IS NULL AND "item_market_cancellations"."settled_reference" IS NULL AND "item_market_cancellations"."settled_tx_signature" IS NULL AND "item_market_cancellations"."settled_buyer" IS NULL AND "item_market_cancellations"."settled_buyer_base_id" IS NULL)
    OR ("item_market_cancellations"."state" = 'cancelled' AND "item_market_cancellations"."resolved_at" IS NOT NULL AND "item_market_cancellations"."refusal_code" IS NULL AND "item_market_cancellations"."settled_reference" IS NULL AND "item_market_cancellations"."settled_tx_signature" IS NULL AND "item_market_cancellations"."settled_buyer" IS NULL AND "item_market_cancellations"."settled_buyer_base_id" IS NULL)
    OR ("item_market_cancellations"."state" = 'settled' AND "item_market_cancellations"."resolved_at" IS NOT NULL AND "item_market_cancellations"."refusal_code" IS NULL AND "item_market_cancellations"."settled_reference" IS NOT NULL AND "item_market_cancellations"."settled_tx_signature" IS NOT NULL AND "item_market_cancellations"."settled_buyer" IS NOT NULL AND ("item_market_cancellations"."source_base_id" IS NULL) = ("item_market_cancellations"."settled_buyer_base_id" IS NULL))
    OR ("item_market_cancellations"."state" = 'refused' AND "item_market_cancellations"."resolved_at" IS NOT NULL AND "item_market_cancellations"."refusal_code" IS NOT NULL AND "item_market_cancellations"."settled_reference" IS NULL AND "item_market_cancellations"."settled_tx_signature" IS NULL AND "item_market_cancellations"."settled_buyer" IS NULL AND "item_market_cancellations"."settled_buyer_base_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "item_market_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"contract_version" integer DEFAULT 1 NOT NULL,
	"buyer_wallet" text NOT NULL,
	"request_key" text,
	"request_payload" jsonb,
	"item_id" text NOT NULL,
	"source_base_id" uuid,
	"buyer_base_id" uuid,
	"seller_wallet" text NOT NULL,
	"cluster" text NOT NULL,
	"reference" text NOT NULL,
	"price_lamports" bigint NOT NULL,
	"fee_bps" integer NOT NULL,
	"seller_lamports" bigint NOT NULL,
	"fee_lamports" bigint NOT NULL,
	"fee_treasury" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"payable_until" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"payment_sig" text,
	"tx_signature" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "item_market_reservations_reference_unique" UNIQUE("reference"),
	CONSTRAINT "item_market_reservation_quote_ck" CHECK (
    "item_market_reservations"."contract_version" = 1 AND "item_market_reservations"."cluster" IN ('devnet','mainnet-beta')
    AND "item_market_reservations"."buyer_wallet" <> "item_market_reservations"."seller_wallet" AND "item_market_reservations"."buyer_wallet" <> "item_market_reservations"."fee_treasury" AND "item_market_reservations"."seller_wallet" <> "item_market_reservations"."fee_treasury"
    AND ("item_market_reservations"."source_base_id" IS NULL) = ("item_market_reservations"."buyer_base_id" IS NULL)
    AND ("item_market_reservations"."request_key" IS NULL) = ("item_market_reservations"."request_payload" IS NULL)
    AND "item_market_reservations"."price_lamports" > 0 AND "item_market_reservations"."seller_lamports" > 0 AND "item_market_reservations"."fee_lamports" >= 0
    AND "item_market_reservations"."fee_bps" BETWEEN 0 AND 10000
    AND "item_market_reservations"."price_lamports" = "item_market_reservations"."seller_lamports" + "item_market_reservations"."fee_lamports"
    AND "item_market_reservations"."fee_lamports" = floor("item_market_reservations"."price_lamports"::numeric * "item_market_reservations"."fee_bps" / 10000)
    AND "item_market_reservations"."payable_until" > "item_market_reservations"."created_at"),
	CONSTRAINT "item_market_reservation_state_ck" CHECK (
    ("item_market_reservations"."state" = 'reserved' AND "item_market_reservations"."payment_sig" IS NULL AND "item_market_reservations"."tx_signature" IS NULL AND "item_market_reservations"."resolved_at" IS NULL)
    OR ("item_market_reservations"."state" = 'committed' AND "item_market_reservations"."payment_sig" IS NOT NULL AND "item_market_reservations"."tx_signature" IS NULL AND "item_market_reservations"."resolved_at" IS NULL)
    OR ("item_market_reservations"."state" = 'settled' AND "item_market_reservations"."tx_signature" IS NOT NULL AND "item_market_reservations"."resolved_at" IS NOT NULL AND ("item_market_reservations"."payment_sig" IS NULL OR "item_market_reservations"."payment_sig" = "item_market_reservations"."tx_signature"))
    OR ("item_market_reservations"."state" IN ('superseded','cancelled') AND "item_market_reservations"."tx_signature" IS NULL AND "item_market_reservations"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "item_market_cancellations" ADD CONSTRAINT "item_market_cancellations_actor_wallet_players_wallet_fk" FOREIGN KEY ("actor_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_market_cancellations" ADD CONSTRAINT "item_market_cancellations_listing_id_item_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."item_listings"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_market_cancellations" ADD CONSTRAINT "item_market_cancellations_source_base_id_bases_id_fk" FOREIGN KEY ("source_base_id") REFERENCES "public"."bases"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_market_cancellations" ADD CONSTRAINT "item_market_cancellations_settled_buyer_players_wallet_fk" FOREIGN KEY ("settled_buyer") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_market_cancellations" ADD CONSTRAINT "item_market_cancellations_settled_buyer_base_id_bases_id_fk" FOREIGN KEY ("settled_buyer_base_id") REFERENCES "public"."bases"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_market_reservations" ADD CONSTRAINT "item_market_reservations_listing_id_item_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."item_listings"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_market_reservations" ADD CONSTRAINT "item_market_reservations_buyer_wallet_players_wallet_fk" FOREIGN KEY ("buyer_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_market_reservations" ADD CONSTRAINT "item_market_reservations_source_base_id_bases_id_fk" FOREIGN KEY ("source_base_id") REFERENCES "public"."bases"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_market_reservations" ADD CONSTRAINT "item_market_reservations_buyer_base_id_bases_id_fk" FOREIGN KEY ("buyer_base_id") REFERENCES "public"."bases"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_market_reservations" ADD CONSTRAINT "item_market_reservations_seller_wallet_players_wallet_fk" FOREIGN KEY ("seller_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "item_market_cancellation_key_uq" ON "item_market_cancellations" USING btree ("actor_wallet","request_key");
--> statement-breakpoint
CREATE INDEX "item_market_cancellation_listing_idx" ON "item_market_cancellations" USING btree ("listing_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "item_market_reservation_key_uq" ON "item_market_reservations" USING btree ("buyer_wallet","request_key") WHERE "item_market_reservations"."request_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "item_market_reservation_listing_idx" ON "item_market_reservations" USING btree ("listing_id");
--> statement-breakpoint
CREATE INDEX "item_market_reservation_buyer_idx" ON "item_market_reservations" USING btree ("buyer_wallet","created_at");
--> statement-breakpoint
CREATE INDEX "item_market_reservation_payment_idx" ON "item_market_reservations" USING btree ("payment_sig");
--> statement-breakpoint
CREATE UNIQUE INDEX "item_market_reservation_tx_uq" ON "item_market_reservations" USING btree ("tx_signature");
--> statement-breakpoint
-- Retained evidence is the one-way capability latch. No quote is backfilled from
-- pre-migration mutable rows: those references finish only through legacy APIs.
CREATE FUNCTION public.shardkeep_item_market_required_contract() RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM item_market_reservations)
    OR EXISTS (SELECT 1 FROM item_market_cancellations) THEN 1 ELSE 0 END
$$;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_item_market_write_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE retained boolean;
BEGIN
  IF TG_TABLE_NAME = 'item_listings' THEN
    retained := EXISTS (SELECT 1 FROM item_market_reservations WHERE listing_id = OLD.id)
      OR EXISTS (SELECT 1 FROM item_market_cancellations WHERE listing_id = OLD.id);
    IF retained AND current_setting('shardkeep.item_market_recovery', true) IS DISTINCT FROM 'v1' THEN
      RAISE EXCEPTION 'marketplace-receipts-v1 writer required' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND retained AND
      (NEW.id, NEW.item_id, NEW.base_id, NEW.price_lamports, NEW.idempotency_key, NEW.created_at)
      IS DISTINCT FROM (OLD.id, OLD.item_id, OLD.base_id, OLD.price_lamports, OLD.idempotency_key, OLD.created_at) THEN
      RAISE EXCEPTION 'marketplace listing identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF current_setting('shardkeep.item_market_recovery', true) IS DISTINCT FROM 'v1' THEN
    RAISE EXCEPTION 'marketplace-receipts-v1 writer required' USING ERRCODE = '23514';
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'marketplace receipts are retained' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'item_market_reservations' THEN
      IF (to_jsonb(NEW) - ARRAY['state','payment_sig','tx_signature','resolved_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','payment_sig','tx_signature','resolved_at']) THEN
        RAISE EXCEPTION 'marketplace quote is immutable' USING ERRCODE = '23514';
      END IF;
      IF (OLD.state = 'committed' AND NEW.state NOT IN ('committed','settled'))
        OR (OLD.payment_sig IS NOT NULL AND NEW.payment_sig IS DISTINCT FROM OLD.payment_sig)
        OR (OLD.state IN ('settled','superseded','cancelled') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
        RAISE EXCEPTION 'marketplace receipt lifecycle cannot regress' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF (to_jsonb(NEW) - ARRAY['state','resolved_at','refusal_code','settled_reference','settled_tx_signature','settled_buyer','settled_buyer_base_id'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','resolved_at','refusal_code','settled_reference','settled_tx_signature','settled_buyer','settled_buyer_base_id'])
        OR (OLD.state <> 'pending' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
        RAISE EXCEPTION 'marketplace cancellation evidence is immutable' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER item_market_listing_writer BEFORE UPDATE OR DELETE ON item_listings
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_item_market_write_guard();
--> statement-breakpoint
CREATE TRIGGER item_market_reservation_writer BEFORE INSERT OR UPDATE OR DELETE ON item_market_reservations
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_item_market_write_guard();
--> statement-breakpoint
CREATE TRIGGER item_market_cancellation_writer BEFORE INSERT OR UPDATE OR DELETE ON item_market_cancellations
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_item_market_write_guard();
--> statement-breakpoint
CREATE TRIGGER item_market_reservation_retention BEFORE TRUNCATE ON item_market_reservations
FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_item_market_write_guard();
--> statement-breakpoint
CREATE TRIGGER item_market_cancellation_retention BEFORE TRUNCATE ON item_market_cancellations
FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_item_market_write_guard();
--> statement-breakpoint
-- Inspect final transaction state, never an intermediate NEW snapshot. All
-- application paths lock players/signatures/listing in their canonical order;
-- this validator only reads and cannot grant inventory or synthesize history.
CREATE FUNCTION public.shardkeep_item_market_consistency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target uuid; listing item_listings%ROWTYPE; reservation item_market_reservations%ROWTYPE;
  cancellation item_market_cancellations%ROWTYPE; exact_quote boolean; fresh_reference boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'item_listings' THEN
    target := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
    IF TG_OP = 'INSERT' THEN fresh_reference := NEW.status = 'reserved';
    ELSIF TG_OP = 'UPDATE' THEN fresh_reference := NEW.status = 'reserved' AND NEW.reference IS DISTINCT FROM OLD.reference;
    END IF;
  ELSE
    target := CASE WHEN TG_OP = 'DELETE' THEN OLD.listing_id ELSE NEW.listing_id END;
  END IF;
  SELECT * INTO listing FROM item_listings WHERE id = target;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM item_market_reservations WHERE listing_id = target)
      OR EXISTS (SELECT 1 FROM item_market_cancellations WHERE listing_id = target) THEN
      RAISE EXCEPTION 'marketplace recorded listing is missing' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;
  IF fresh_reference AND listing.status = 'reserved'
    AND NOT EXISTS (SELECT 1 FROM item_market_reservations WHERE listing_id = target AND reference = listing.reference)
    AND (NOT (current_database() = 'shardkeep_test' AND current_setting('shardkeep.allow_legacy_test', true) IS NOT DISTINCT FROM 'on')
      OR EXISTS (SELECT 1 FROM item_market_reservations WHERE listing_id = target)) THEN
    RAISE EXCEPTION 'marketplace fresh reservation requires immutable quote' USING ERRCODE = '23514';
  END IF;
  FOR reservation IN SELECT * FROM item_market_reservations WHERE listing_id = target LOOP
    exact_quote := (listing.id, listing.item_id, listing.base_id, listing.buyer_base_id, listing.seller_wallet,
      listing.reserved_by, listing.reference, listing.price_lamports, listing.reserved_until)
      IS NOT DISTINCT FROM (reservation.listing_id, reservation.item_id, reservation.source_base_id, reservation.buyer_base_id,
      reservation.seller_wallet, reservation.buyer_wallet, reservation.reference, reservation.price_lamports, reservation.payable_until);
    IF reservation.state IN ('reserved','committed') AND
      (NOT exact_quote OR listing.status <> 'reserved' OR listing.payment_sig IS DISTINCT FROM reservation.payment_sig
        OR listing.tx_signature IS NOT NULL OR listing.buyer_wallet IS NOT NULL) THEN
      RAISE EXCEPTION 'marketplace live generation disagrees with receipt' USING ERRCODE = '23514';
    ELSIF reservation.state = 'settled' AND
      (NOT exact_quote OR listing.status <> 'sold' OR listing.tx_signature IS DISTINCT FROM reservation.tx_signature
        OR listing.payment_sig IS DISTINCT FROM reservation.payment_sig OR listing.buyer_wallet IS DISTINCT FROM reservation.buyer_wallet) THEN
      RAISE EXCEPTION 'marketplace settlement disagrees with receipt' USING ERRCODE = '23514';
    ELSIF reservation.state = 'superseded' AND listing.reference IS NOT DISTINCT FROM reservation.reference THEN
      RAISE EXCEPTION 'marketplace superseded generation is still current' USING ERRCODE = '23514';
    ELSIF reservation.state = 'cancelled' AND listing.status <> 'cancelled' THEN
      RAISE EXCEPTION 'marketplace cancellation disagrees with receipt' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  FOR cancellation IN SELECT * FROM item_market_cancellations WHERE listing_id = target LOOP
    IF cancellation.state = 'cancelled' AND (listing.status <> 'cancelled'
      OR (listing.item_id, listing.base_id, listing.price_lamports) IS DISTINCT FROM
        (cancellation.item_id, cancellation.source_base_id, cancellation.price_lamports)) THEN
      RAISE EXCEPTION 'marketplace cancellation outcome disagrees with listing' USING ERRCODE = '23514';
    ELSIF cancellation.state = 'settled' AND (listing.status <> 'sold'
      OR (listing.item_id, listing.base_id, listing.price_lamports, listing.reference, listing.tx_signature, listing.buyer_wallet, listing.buyer_base_id)
        IS DISTINCT FROM (cancellation.item_id, cancellation.source_base_id, cancellation.price_lamports,
          cancellation.settled_reference, cancellation.settled_tx_signature, cancellation.settled_buyer, cancellation.settled_buyer_base_id)
      OR cancellation.expected_reference IS DISTINCT FROM cancellation.settled_reference) THEN
      RAISE EXCEPTION 'marketplace cancellation settlement disagrees with listing' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER item_market_listing_consistency AFTER INSERT OR UPDATE OR DELETE ON item_listings
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_item_market_consistency();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER item_market_reservation_consistency AFTER INSERT OR UPDATE OR DELETE ON item_market_reservations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_item_market_consistency();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER item_market_cancellation_consistency AFTER INSERT OR UPDATE OR DELETE ON item_market_cancellations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_item_market_consistency();
