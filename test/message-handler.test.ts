import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { handleFrame } from "../src/message-handler.js";
import { MAX_CONTENT_LENGTH, MAX_FRAME_BYTES } from "../src/protocol.js";

function frame(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

describe("handleFrame", () => {
  it("acknowledges a valid message", () => {
    const messageId = randomUUID();

    expect(
      handleFrame(
        frame({
          type: "message",
          messageId,
          conversationId: randomUUID(),
          content: "Hello",
        }),
        false,
      ),
    ).toEqual({
      type: "ack",
      messageId,
      status: "accepted",
    });
  });

  it("rejects malformed JSON", () => {
    expect(handleFrame(Buffer.from("{"), false)).toEqual({
      type: "error",
      code: "MALFORMED_JSON",
      message: "Message must be valid JSON",
    });
  });

  it("rejects binary frames", () => {
    expect(handleFrame(Buffer.from("ignored"), true)).toEqual({
      type: "error",
      code: "BINARY_NOT_SUPPORTED",
      message: "Only JSON text messages are supported",
    });
  });

  it("returns safe validation details and a valid messageId", () => {
    const messageId = randomUUID();
    const response = handleFrame(
      frame({
        type: "message",
        messageId,
        conversationId: "not-a-uuid",
        content: "   ",
      }),
      false,
    );

    expect(response).toMatchObject({
      type: "error",
      code: "VALIDATION_ERROR",
      messageId,
    });
    if (response.type !== "error") {
      throw new Error("Expected an error response");
    }
    const fields = response.details?.map((detail) => detail.field);
    expect(fields).toContain("conversationId");
    expect(fields).toContain("content");
    expect(JSON.stringify(response)).not.toContain('"content":"   "');
  });

  it("does not echo an invalid messageId", () => {
    const response = handleFrame(
      frame({
        type: "message",
        messageId: "not-a-uuid",
        conversationId: randomUUID(),
        content: "Hello",
      }),
      false,
    );

    expect(response).not.toHaveProperty("messageId");
  });

  it("rejects content longer than the configured limit", () => {
    const response = handleFrame(
      frame({
        type: "message",
        messageId: randomUUID(),
        conversationId: randomUUID(),
        content: "a".repeat(MAX_CONTENT_LENGTH + 1),
      }),
      false,
    );

    expect(response).toMatchObject({
      type: "error",
      code: "VALIDATION_ERROR",
    });
    if (response.type !== "error") {
      throw new Error("Expected an error response");
    }
    expect(response.details?.map((detail) => detail.field)).toContain(
      "content",
    );
  });

  it("rejects application frames over the byte limit", () => {
    const response = handleFrame(Buffer.alloc(MAX_FRAME_BYTES + 1, "a"), false);

    expect(response).toMatchObject({
      type: "error",
      code: "FRAME_TOO_LARGE",
    });
  });
});
