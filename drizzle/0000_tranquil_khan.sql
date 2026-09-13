CREATE TABLE IF NOT EXISTS "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120),
	"picture" varchar(2048),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_id" uuid NOT NULL,
	"content" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation_members" (
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_message" uuid,
	CONSTRAINT "conversation_members_pkey" PRIMARY KEY("user_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "conversation" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "conversation" ALTER COLUMN "picture" TYPE varchar(2048);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'message_id_conversation_id_unique'
	) THEN
		ALTER TABLE "message" ADD CONSTRAINT "message_id_conversation_id_unique" UNIQUE("id","conversation_id");
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'conversation_members_conversation_id_conversation_id_fk'
	) THEN
		ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'conversation_members_last_seen_message_message_id_fk'
	) THEN
		ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_last_seen_message_message_id_fk" FOREIGN KEY ("last_seen_message") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'message_conversation_id_conversation_id_fk'
	) THEN
		ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_members_conversation_idx" ON "conversation_members" USING btree ("conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_conversation_history_idx" ON "message" USING btree ("conversation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);