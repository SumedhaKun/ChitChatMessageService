import {
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const conversation = pgTable("conversation", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 120 }),
  picture: varchar("picture", { length: 2_048 }),
  isGroup: boolean("is_group").default(false).notNull(),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "date",
  })
    .defaultNow()
    .notNull(),
});

export const message = pgTable(
  "message",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    senderId: uuid("sender_id").notNull(),
    content: text("content").notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("message_id_conversation_id_unique").on(
      table.id,
      table.conversationId,
    ),
    index("message_conversation_history_idx").on(
      table.conversationId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  ],
);

export const conversationMembers = pgTable(
  "conversation_members",
  {
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    lastSeenMessage: uuid("last_seen_message").references(() => message.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    primaryKey({
      name: "conversation_members_pkey",
      columns: [table.userId, table.conversationId],
    }),
    index("conversation_members_conversation_idx").on(table.conversationId),
  ],
);

export type ConversationRow = typeof conversation.$inferSelect;
export type MessageRow = typeof message.$inferSelect;
export type ConversationMemberRow = typeof conversationMembers.$inferSelect;
