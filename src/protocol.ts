import { z } from "zod";

export const MAX_CONTENT_LENGTH = 4_000;
export const MAX_FRAME_BYTES = 16 * 1024;
export const MAX_TRANSPORT_FRAME_BYTES = 32 * 1024;

export const messageSchema = z
  .object({
    type: z.literal("message"),
    messageId: z.uuid(),
    conversationId: z.uuid(),
    content: z.string().trim().min(1).max(MAX_CONTENT_LENGTH),
  })
  .strict();

export type Message = z.infer<typeof messageSchema>;

export const errorCodes = [
  "BINARY_NOT_SUPPORTED",
  "FRAME_TOO_LARGE",
  "MALFORMED_JSON",
  "VALIDATION_ERROR",
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
}

export interface ErrorResponse {
  type: "error";
  code: ErrorCode;
  message: string;
  messageId?: string;
  details?: ValidationDetail[];
}

export type ServerResponse = Acknowledgment | ErrorResponse;
