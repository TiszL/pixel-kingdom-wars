CREATE TYPE "public"."raid_energy_source" AS ENUM('free', 'purchased');--> statement-breakpoint
ALTER TABLE "raids" ADD COLUMN "energy_source" "raid_energy_source";