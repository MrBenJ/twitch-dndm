CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"twitch_id" text,
	"config" json NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"dock_token_hash" text NOT NULL,
	"dock_token_enc" text NOT NULL,
	"overlay_token_hash" text NOT NULL,
	"overlay_token_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_twitch_id_unique" UNIQUE("twitch_id"),
	CONSTRAINT "channels_dock_token_hash_unique" UNIQUE("dock_token_hash"),
	CONSTRAINT "channels_overlay_token_hash_unique" UNIQUE("overlay_token_hash")
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"channel_id" uuid NOT NULL,
	"id" text NOT NULL,
	"data" json NOT NULL,
	"wake_at" bigint,
	"removed" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "characters_channel_id_id_pk" PRIMARY KEY("channel_id","id")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"state_version" integer NOT NULL,
	"clock" bigint NOT NULL,
	"rng" bigint NOT NULL,
	"seq" integer NOT NULL,
	"session" json,
	"recent_requests" json DEFAULT '[]'::json NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "characters_wake_at" ON "characters" USING btree ("wake_at");--> statement-breakpoint
CREATE INDEX "characters_removed" ON "characters" USING btree ("channel_id","removed");