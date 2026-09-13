import type { MessageRow } from "../db/schema.js";

export interface MessageCreatedEvent {
  messageId: string;
  senderId: string;
  conversationId: string;
  content: string;
  createdAt: string;
}

export function toMessageCreatedEvent(
  message: MessageRow,
): MessageCreatedEvent {
  return {
    messageId: message.id,
    senderId: message.senderId,
    conversationId: message.conversationId,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  };
}
