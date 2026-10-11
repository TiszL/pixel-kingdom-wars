ALTER TABLE "raids" ADD COLUMN "simulation_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "raids" ADD COLUMN "simulation_lease_until" timestamp with time zone;
