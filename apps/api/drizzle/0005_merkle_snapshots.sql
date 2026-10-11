CREATE TABLE "merkle_leaves" (
	"epoch" bigint NOT NULL,
	"leaf_index" integer NOT NULL,
	"wallet" text NOT NULL,
	"amount" bigint NOT NULL,
	CONSTRAINT "merkle_leaves_epoch_leaf_index_pk" PRIMARY KEY("epoch","leaf_index"),
	CONSTRAINT "merkle_leaves_epoch_wallet_unique" UNIQUE("epoch","wallet")
);
--> statement-breakpoint
CREATE TABLE "merkle_snapshots" (
	"epoch" bigint PRIMARY KEY NOT NULL,
	"root" text NOT NULL,
	"total_balance" bigint NOT NULL,
	"leaf_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
