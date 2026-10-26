CREATE TABLE "allowlist" (
	"twitch_id" text PRIMARY KEY NOT NULL,
	"login" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
