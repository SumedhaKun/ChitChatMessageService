import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabaseConnection,
  type DatabaseConnection,
} from "../src/db/client.js";
import { runDatabaseMigrations } from "../src/db/migrations.js";
import {
  conversation,
  conversationMembers,
  message,
} from "../src/db/schema.js";
import {
  ConversationNotFoundError,
  createConversation,
  createMessage,
  listConversationMessages,
  listUserConversations,
  MessageIdConflictError,
  SenderNotMemberError,
} from "../src/api/repository.js";
import { createConversationSchema } from "../src/api/schemas.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase("PostgreSQL repositories", () => {
  let connection: DatabaseConnection;

  beforeAll(async () => {
    connection = createDatabaseConnection(databaseUrl ?? "");
    await runDatabaseMigrations(connection.db);
  });

  afterEach(async () => {
    await connection.db.delete(conversation);
  });

  afterAll(async () => {
    await connection.sql.end();
  });

  it("atomically creates a conversation and deduplicated members", async () => {
    const userId = randomUUID();
    const input = createConversationSchema.parse({
      name: "Project",
      picture: "https://example.com/project.png",
      is_group: true,
      user_ids: [userId, userId],
    });

    const created = await createConversation(connection.db, input, userId);

    expect(created.conversation).toMatchObject({
      name: "Project",
      picture: "https://example.com/project.png",
      isGroup: true,
    });
    expect(created.members).toHaveLength(1);
    expect(created.members[0]?.userId).toBe(userId);
  });

  it("requires the sender to be a conversation member", async () => {
    const memberId = randomUUID();
    const created = await createConversation(
      connection.db,
      { is_group: false, user_ids: [randomUUID()] },
      memberId,
    );

    await expect(
      createMessage(
        connection.db,
        {
          conversation_id: created.conversation.id,
          content: "Not allowed",
        },
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(SenderNotMemberError);

    await expect(
      createMessage(
        connection.db,
        {
          conversation_id: randomUUID(),
          content: "Missing conversation",
        },
        memberId,
      ),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("returns stable newest-first cursor pages", async () => {
    const senderId = randomUUID();
    const created = await createConversation(
      connection.db,
      { is_group: false, user_ids: [randomUUID()] },
      senderId,
    );
    const timestamp = new Date("2026-09-12T20:00:00.000Z");
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();

    await connection.db.insert(message).values(
      ids.map((id) => ({
        id,
        senderId,
        conversationId: created.conversation.id,
        content: id,
        createdAt: timestamp,
      })),
    );

    const firstPage = await listConversationMessages(
      connection.db,
      created.conversation.id,
      senderId,
      2,
    );
    expect(firstPage.messages.map((row) => row.id)).toEqual(ids.slice(0, 2));
    expect(firstPage.hasMore).toBe(true);

    const lastMessage = firstPage.messages[1];
    if (lastMessage === undefined) {
      throw new Error("Expected a second message");
    }
    const secondPage = await listConversationMessages(
      connection.db,
      created.conversation.id,
      senderId,
      2,
      lastMessage,
    );
    expect(secondPage.messages.map((row) => row.id)).toEqual(ids.slice(2));
    expect(secondPage.hasMore).toBe(false);
  });

  it("sets last_seen_message to null when its message is deleted", async () => {
    const userId = randomUUID();
    const created = await createConversation(
      connection.db,
      { is_group: false, user_ids: [randomUUID()] },
      userId,
    );
    const persisted = await createMessage(
      connection.db,
      {
        conversation_id: created.conversation.id,
        content: "Seen",
      },
      userId,
    );
    const createdMessage = persisted.message;

    await connection.db
      .update(conversationMembers)
      .set({ lastSeenMessage: createdMessage.id })
      .where(eq(conversationMembers.conversationId, created.conversation.id));
    await connection.db
      .delete(message)
      .where(eq(message.id, createdMessage.id));

    const [member] = await connection.db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, created.conversation.id));
    expect(member?.lastSeenMessage).toBeNull();
  });

  it("lists only a caller's conversations and all member IDs", async () => {
    const callerId = randomUUID();
    const otherId = randomUUID();
    const created = await createConversation(
      connection.db,
      { is_group: true, user_ids: [otherId] },
      callerId,
    );
    await createConversation(
      connection.db,
      { is_group: false, user_ids: [randomUUID()] },
      randomUUID(),
    );

    const rows = await listUserConversations(connection.db, callerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: created.conversation.id,
      isGroup: true,
    });
    expect(rows[0]?.memberIds).toEqual(
      expect.arrayContaining([callerId, otherId]),
    );
  });

  it("makes message IDs idempotent and rejects mismatched reuse", async () => {
    const senderId = randomUUID();
    const messageId = randomUUID();
    const created = await createConversation(
      connection.db,
      { is_group: false, user_ids: [randomUUID()] },
      senderId,
    );
    const input = {
      message_id: messageId,
      conversation_id: created.conversation.id,
      content: "Retry me",
    };

    const first = await createMessage(connection.db, input, senderId);
    const retry = await createMessage(connection.db, input, senderId);
    expect(first.created).toBe(true);
    expect(retry).toEqual({ created: false, message: first.message });

    await expect(
      createMessage(
        connection.db,
        { ...input, content: "Different" },
        senderId,
      ),
    ).rejects.toBeInstanceOf(MessageIdConflictError);
  });

  it("requires membership when listing messages", async () => {
    const callerId = randomUUID();
    const created = await createConversation(
      connection.db,
      { is_group: false, user_ids: [randomUUID()] },
      callerId,
    );

    await expect(
      listConversationMessages(
        connection.db,
        created.conversation.id,
        randomUUID(),
        50,
      ),
    ).rejects.toBeInstanceOf(SenderNotMemberError);
  });
});
