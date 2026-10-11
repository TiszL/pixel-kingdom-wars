CREATE TABLE "hero_recruitment_commands" (
  "actor_wallet" text NOT NULL REFERENCES "public"."players"("wallet"),
  "request_key" uuid NOT NULL,
  "receipt" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "hero_recruitment_commands_actor_wallet_request_key_pk" PRIMARY KEY ("actor_wallet", "request_key"),
  CONSTRAINT "hero_recruitment_commands_identity_ck" CHECK ((
    jsonb_typeof(receipt) = 'object'
    AND receipt->>'version' = '1'
    AND receipt->>'actor' = actor_wallet
    AND receipt->>'idempotencyKey' = request_key::text
    AND receipt->'request'->>'idempotencyKey' = request_key::text
  ) IS TRUE)
);
--> statement-breakpoint
-- Accepted construction belongs to the original actor forever. No foreign key
-- to a movable/deletable building, job or base can erase historical proof.
CREATE FUNCTION public.shardkeep_hero_recruitment_retention() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Hero recruitment commands are immutable and retained' USING ERRCODE = '23514';
END
$$;
--> statement-breakpoint
CREATE TRIGGER hero_recruitment_immutable BEFORE UPDATE OR DELETE ON hero_recruitment_commands
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_hero_recruitment_retention();
--> statement-breakpoint
CREATE TRIGGER hero_recruitment_retention BEFORE TRUNCATE ON hero_recruitment_commands
FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_hero_recruitment_retention();
