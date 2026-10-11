ALTER TYPE "public"."account_kind" ADD VALUE 'clan_chest' BEFORE 'shard_genesis';--> statement-breakpoint
ALTER TABLE "clans" ADD COLUMN "chest_shards" bigint DEFAULT 0 NOT NULL;