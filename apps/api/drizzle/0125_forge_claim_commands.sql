CREATE TABLE "forge_claim_commands" (
	"actor_wallet" text NOT NULL,
	"request_key" uuid NOT NULL,
	"base_id" uuid,
	"day" date,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forge_claim_commands_actor_wallet_request_key_pk" PRIMARY KEY("actor_wallet","request_key")
);
--> statement-breakpoint
ALTER TABLE "forge_claim_commands" ADD CONSTRAINT "forge_claim_commands_actor_wallet_players_wallet_fk" FOREIGN KEY ("actor_wallet") REFERENCES "public"."players"("wallet") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Historical completed claims (including an empty batch) must not be erased or
-- rewritten by a later application or by a rollback to legacy Forge routes.
CREATE FUNCTION public.shardkeep_forge_claim_retention() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Forge claim commands are immutable and retained' USING ERRCODE = '23514';
END
$$;
--> statement-breakpoint
CREATE TRIGGER forge_claim_immutable BEFORE UPDATE OR DELETE ON forge_claim_commands
FOR EACH ROW EXECUTE FUNCTION public.shardkeep_forge_claim_retention();
--> statement-breakpoint
CREATE TRIGGER forge_claim_retention BEFORE TRUNCATE ON forge_claim_commands
FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_forge_claim_retention();
