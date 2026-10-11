CREATE TYPE "public"."alpha_access_source" AS ENUM('env', 'invite', 'manual');--> statement-breakpoint
CREATE TYPE "public"."alpha_application_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "alpha_access" (
	"wallet" text PRIMARY KEY NOT NULL,
	"source" "alpha_access_source" NOT NULL,
	"application_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alpha_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"handle" text,
	"socials" text,
	"answers" jsonb,
	"status" "alpha_application_status" DEFAULT 'pending' NOT NULL,
	"invite_code" text,
	"invited_at" timestamp with time zone,
	"redeemed_wallet" text,
	"redeemed_at" timestamp with time zone,
	"reviewer_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alpha_applications_email_unique" UNIQUE("email"),
	CONSTRAINT "alpha_applications_invite_code_unique" UNIQUE("invite_code")
);
--> statement-breakpoint
ALTER TABLE "alpha_access" ADD CONSTRAINT "alpha_access_application_id_alpha_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."alpha_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alpha_applications_status_idx" ON "alpha_applications" USING btree ("status","created_at");