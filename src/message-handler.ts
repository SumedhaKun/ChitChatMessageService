import { z } from "zod";

import {
  MAX_FRAME_BYTES,
  messageSchema,
  type ErrorResponse,
  type ServerResponse,
} from "./protocol.js";

const messageIdSchema = z.uuid();

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

export function handleFrame(data: Buffer, isBinary: boolean): ServerResponse {
  if (isBinary) {
    return errorResponse(
      "BINARY_NOT_SUPPORTED",
      "Only JSON text messages are supported",
    );
  }

  if (data.byteLength > MAX_FRAME_BYTES) {
    return errorResponse(
      "FRAME_TOO_LARGE",
      `Message frame must not exceed ${MAX_FRAME_BYTES} bytes`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(data.toString("utf8")) as unknown;
  } catch {
    return errorResponse("MALFORMED_JSON", "Message must be valid JSON");
  }

  const messageId = extractMessageId(value);
  const result = messageSchema.safeParse(value);

  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.length === 0 ? "$" : issue.path.join("."),
      message: issue.message,
    }));

    return errorResponse(
      "VALIDATION_ERROR",
      "Message payload is invalid",
      messageId,
      details,
    );
  }

  return {
    type: "ack",
    messageId: result.data.messageId,
    status: "accepted",
  };
}
