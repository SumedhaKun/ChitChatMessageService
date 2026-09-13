import { z } from "zod";

export const MAX_CONTENT_LENGTH = 4_000;
export const MAX_FRAME_BYTES = 16 * 1024;
export const MAX_TRANSPORT_FRAME_BYTES = 32 * 1024;

export const authSchema = z
  .object({
    type: z.literal("auth"),
    accessToken: z.string().min(1),
  })
  .strict();

export const messageSchema = z
  .object({
    type: z.literal("message"),
    messageId: z.uuid(),
    conversationId: z.uuid(),
    content: z.string().trim().min(1).max(MAX_CONTENT_LENGTH),
  })
  .strict();

export type Message = z.infer<typeof messageSchema>;
export type Auth = z.infer<typeof authSchema>;

export const errorCodes = [
  "AUTH_REQUIRED",
  "AUTH_FAILED",
  "ALREADY_AUTHENTICATED",
  "BINARY_NOT_SUPPORTED",
  "FRAME_TOO_LARGE",
  "MALFORMED_JSON",
  "VALIDATION_ERROR",
  "CONVERSATION_NOT_FOUND",
  "SENDER_NOT_MEMBER",
  "MESSAGE_ID_CONFLICT",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export interface ValidationDetail {
  field: string;
  message: string;
}

export interface Acknowledgment {
  type: "ack";
  messageId: string;
  status: "accepted";
  message: {
    id: string;
    senderId: string;
    conversationId: string;
    content: string;
    createdAt: Date;
  };
}

export interface AuthenticationAcknowledgment {
  type: "auth_ack";
}

export interface ErrorResponse {
  type: "error";
  code: ErrorCode;
  message: string;
  messageId?: string;
  details?: ValidationDetail[];
}

export type ServerResponse =
  AuthenticationAcknowledgment | Acknowledgment | ErrorResponse;
