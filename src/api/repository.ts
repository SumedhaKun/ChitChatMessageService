import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, lt, or } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  conversation,
  conversationMembers,
  message,
  type ConversationMemberRow,
  type ConversationRow,
  type MessageRow,
} from "../db/schema.js";
import type { MessageCursor } from "./cursor.js";
import type {
  CreateConversationInput,
  CreateMessageInput,
  UpdateLastSeenMessageInput,
} from "./schemas.js";

export class ConversationNotFoundError extends Error {
  constructor() {
    super("Conversation not found");
    this.name = "ConversationNotFoundError";
  }
}

export class SenderNotMemberError extends Error {
  constructor() {
    super("Sender is not a member of the conversation");
    this.name = "SenderNotMemberError";
  }
}

export class MessageIdConflictError extends Error {
  constructor() {
    super("Message ID is already used by a different message");
    this.name = "MessageIdConflictError";
  }
}

export class MessageNotFoundError extends Error {
  constructor() {
    super("Message not found in conversation");
    this.name = "MessageNotFoundError";
  }
}

export class NotDirectConversationError extends Error {
  constructor() {
    super("Read receipts are only available for direct conversations");
    this.name = "NotDirectConversationError";
  }
}

export interface ConversationWithMembers {
  conversation: ConversationRow;
  members: ConversationMemberRow[];
}

export interface MessagePage {
  messages: MessageRow[];
  hasMore: boolean;
}

export interface ConversationSummary extends ConversationRow {
  memberIds: string[];
}

export interface PersistMessageResult {
  message: MessageRow;
  created: boolean;
}

export async function createConversation(
  db: Database,
  input: CreateConversationInput,
  callerId: string,
): Promise<ConversationWithMembers> {
  return await db.transaction(async (transaction) => {
    const [createdConversation] = await transaction
      .insert(conversation)
      .values({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.picture === undefined ? {} : { picture: input.picture }),
        isGroup: input.is_group,
      })
      .returning();

    if (createdConversation === undefined) {
      throw new Error("Conversation insert returned no row");
    }

    const members = await transaction
      .insert(conversationMembers)
      .values(
        [...new Set([callerId, ...input.user_ids])].map((userId) => ({
          userId,
          conversationId: createdConversation.id,
        })),
      )
      .returning();

    return {
      conversation: createdConversation,
      members,
    };
  });
}

export async function createMessage(
  db: Database,
  input: CreateMessageInput,
  senderId: string,
): Promise<PersistMessageResult> {
  return await db.transaction(async (transaction) => {
    const [existingConversation] = await transaction
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.id, input.conversation_id))
      .limit(1);

    if (existingConversation === undefined) {
      throw new ConversationNotFoundError();
    }

    const [membership] = await transaction
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, input.conversation_id),
          eq(conversationMembers.userId, senderId),
        ),
      )
      .limit(1);

    if (membership === undefined) {
      throw new SenderNotMemberError();
    }

    const messageId = input.message_id ?? randomUUID();
    const [createdMessage] = await transaction
      .insert(message)
      .values({
        id: messageId,
        senderId,
        conversationId: input.conversation_id,
        content: input.content,
      })
      .onConflictDoNothing({ target: message.id })
      .returning();

    if (createdMessage !== undefined) {
      return { message: createdMessage, created: true };
    }

    const [existingMessage] = await transaction
      .select()
      .from(message)
      .where(eq(message.id, messageId))
      .limit(1);

    if (existingMessage === undefined) {
      throw new Error("Message conflict returned no existing row");
    }

    if (
      existingMessage.senderId !== senderId ||
      existingMessage.conversationId !== input.conversation_id ||
      existingMessage.content !== input.content
    ) {
      throw new MessageIdConflictError();
    }

    return { message: existingMessage, created: false };
  });
}

export async function listUserConversations(
  db: Database,
  userId: string,
): Promise<ConversationSummary[]> {
  const memberships = await db
    .select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(eq(conversationMembers.userId, userId));
  const conversationIds = memberships.map((row) => row.conversationId);

  if (conversationIds.length === 0) {
    return [];
  }

  const [conversationRows, memberRows] = await Promise.all([
    db
      .select()
      .from(conversation)
      .where(inArray(conversation.id, conversationIds))
      .orderBy(desc(conversation.createdAt), desc(conversation.id)),
    db
      .select({
        conversationId: conversationMembers.conversationId,
        userId: conversationMembers.userId,
      })
      .from(conversationMembers)
      .where(inArray(conversationMembers.conversationId, conversationIds)),
  ]);

  const memberIdsByConversation = new Map<string, string[]>();
  for (const row of memberRows) {
    const memberIds = memberIdsByConversation.get(row.conversationId) ?? [];
    memberIds.push(row.userId);
    memberIdsByConversation.set(row.conversationId, memberIds);
  }

  return conversationRows.map((row) => ({
    ...row,
    memberIds: memberIdsByConversation.get(row.id) ?? [],
  }));
}

export async function listConversationMessages(
  db: Database,
  conversationId: string,
  userId: string,
  limit: number,
  cursor?: MessageCursor,
): Promise<MessagePage> {
  const [existingConversation] = await db
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .limit(1);

  if (existingConversation === undefined) {
    throw new ConversationNotFoundError();
  }

  const [membership] = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    )
    .limit(1);

  if (membership === undefined) {
    throw new SenderNotMemberError();
  }

  const cursorCondition =
    cursor === undefined
      ? undefined
      : or(
          lt(message.createdAt, cursor.createdAt),
          and(
            eq(message.createdAt, cursor.createdAt),
            lt(message.id, cursor.id),
          ),
        );

  const rows = await db
    .select()
    .from(message)
    .where(
      cursorCondition === undefined
        ? eq(message.conversationId, conversationId)
        : and(eq(message.conversationId, conversationId), cursorCondition),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(limit + 1);

  return {
    messages: rows.slice(0, limit),
    hasMore: rows.length > limit,
  };
}

export async function updateLastSeenMessage(
  db: Database,
  conversationId: string,
  userId: string,
  input: UpdateLastSeenMessageInput,
): Promise<ConversationMemberRow> {
  const [existingConversation] = await db
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .limit(1);

  if (existingConversation === undefined) {
    throw new ConversationNotFoundError();
  }

  const [membership] = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    )
    .limit(1);

  if (membership === undefined) {
    throw new SenderNotMemberError();
  }

  const [existingMessage] = await db
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.id, input.message_id),
        eq(message.conversationId, conversationId),
      ),
    )
    .limit(1);

  if (existingMessage === undefined) {
    throw new MessageNotFoundError();
  }

  const [updatedMember] = await db
    .update(conversationMembers)
    .set({ lastSeenMessage: input.message_id })
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    )
    .returning();

  if (updatedMember === undefined) {
    throw new Error("Last seen update returned no row");
  }

  return updatedMember;
}

export async function getOtherParticipantLastSeenMessage(
  db: Database,
  conversationId: string,
  callerId: string,
): Promise<string | null> {
  const [existingConversation] = await db
    .select({ id: conversation.id, isGroup: conversation.isGroup })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .limit(1);

  if (existingConversation === undefined) {
    throw new ConversationNotFoundError();
  }

  if (existingConversation.isGroup) {
    throw new NotDirectConversationError();
  }

  const members = await db
    .select({
      userId: conversationMembers.userId,
      lastSeenMessage: conversationMembers.lastSeenMessage,
    })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId));

  const callerMembership = members.find((member) => member.userId === callerId);
  if (callerMembership === undefined) {
    throw new SenderNotMemberError();
  }

  const otherMember = members.find((member) => member.userId !== callerId);
  if (otherMember === undefined) {
    throw new NotDirectConversationError();
  }

  return otherMember.lastSeenMessage;
}
