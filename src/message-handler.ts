import { z } from "zod";

import type { Authenticate, AuthenticatedUser } from "./auth.js";
import {
  ConversationNotFoundError,
  MessageIdConflictError,
  SenderNotMemberError,
  type PersistMessageResult,
} from "./api/repository.js";
import type { CreateMessageInput } from "./api/schemas.js";
import {
  authSchema,
  MAX_FRAME_BYTES,
  messageSchema,
  type ErrorResponse,
  type ServerResponse,
} from "./protocol.js";

const messageIdSchema = z.uuid();

export type PersistMessage = (
  input: CreateMessageInput,
  senderId: string,
) => Promise<PersistMessageResult>;

export interface FrameDependencies {
  authenticate: Authenticate;
  persistMessage: PersistMessage;
}

export interface FrameResult {
  response: ServerResponse;
  authenticatedUser?: AuthenticatedUser;
}

function errorResponse(
  code: ErrorResponse["code"],
  message: string,
  messageId?: string,
  details?: ErrorResponse["details"],
): ErrorResponse {
  return {
    type: "error",
    code,
    message,
    ...(messageId === undefined ? {} : { messageId }),
    ...(details === undefined ? {} : { details }),
  };
}

function extractMessageId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const result = messageIdSchema.safeParse(
    (value as Record<string, unknown>).messageId,
  );
  return result.success ? result.data : undefined;
}

export async function handleFrame(
  data: Buffer,
  isBinary: boolean,
  authenticatedUser: AuthenticatedUser | undefined,
  dependencies: FrameDependencies,
): Promise<FrameResult> {
  if (isBinary) {
    return {
      response: errorResponse(
        "BINARY_NOT_SUPPORTED",
        "Only JSON text messages are supported",
      ),
    };
  }

  if (data.byteLength > MAX_FRAME_BYTES) {
    return {
      response: errorResponse(
        "FRAME_TOO_LARGE",
        `Message frame must not exceed ${MAX_FRAME_BYTES} bytes`,
      ),
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(data.toString("utf8")) as unknown;
  } catch {
    return {
      response: errorResponse("MALFORMED_JSON", "Message must be valid JSON"),
    };
  }

  const frameType =
    typeof value === "object" && value !== null && "type" in value
      ? (value as { type?: unknown }).type
      : undefined;

  if (authenticatedUser === undefined) {
    if (frameType !== "auth") {
      return {
        response: errorResponse(
          "AUTH_REQUIRED",
          "Authenticate before sending messages",
          extractMessageId(value),
        ),
      };
    }

    const authResult = authSchema.safeParse(value);
    if (!authResult.success) {
      return {
        response: errorResponse(
          "VALIDATION_ERROR",
          "Authentication payload is invalid",
          undefined,
          authResult.error.issues.map((issue) => ({
            field: issue.path.length === 0 ? "$" : issue.path.join("."),
            message: issue.message,
          })),
        ),
      };
    }

    const user = await dependencies.authenticate(authResult.data.accessToken);
    if (user === null) {
      return {
        response: errorResponse(
          "AUTH_FAILED",
          "Access token is invalid or expired",
        ),
      };
    }

    return {
      response: { type: "auth_ack" },
      authenticatedUser: user,
    };
  }

  if (frameType === "auth") {
    return {
      response: errorResponse(
        "ALREADY_AUTHENTICATED",
        "Connection is already authenticated",
      ),
    };
  }

  const messageId = extractMessageId(value);
  const result = messageSchema.safeParse(value);

  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.length === 0 ? "$" : issue.path.join("."),
      message: issue.message,
    }));

    return {
      response: errorResponse(
        "VALIDATION_ERROR",
        "Message payload is invalid",
        messageId,
        details,
      ),
    };
  }

  try {
    const persisted = await dependencies.persistMessage(
      {
        message_id: result.data.messageId,
        conversation_id: result.data.conversationId,
        content: result.data.content,
      },
      authenticatedUser.id,
    );

    return {
      response: {
        type: "ack",
        messageId: persisted.message.id,
        status: "accepted",
        message: persisted.message,
      },
    };
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      return {
        response: errorResponse(
          "CONVERSATION_NOT_FOUND",
          error.message,
          messageId,
        ),
      };
    }
    if (error instanceof SenderNotMemberError) {
      return {
        response: errorResponse("SENDER_NOT_MEMBER", error.message, messageId),
      };
    }
    if (error instanceof MessageIdConflictError) {
      return {
        response: errorResponse(
          "MESSAGE_ID_CONFLICT",
          error.message,
          messageId,
        ),
      };
    }
    throw error;
  }
}
