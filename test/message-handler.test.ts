import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { MessageIdConflictError } from "../src/api/repository.js";
import { handleFrame, type FrameDependencies } from "../src/message-handler.js";
import { MAX_CONTENT_LENGTH, MAX_FRAME_BYTES } from "../src/protocol.js";

function frame(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

const user = { id: randomUUID(), email: "person@example.com" };

function dependencies(
  overrides: Partial<FrameDependencies> = {},
): FrameDependencies {
  const defaults: FrameDependencies = {
    authenticate: () => Promise.resolve(user),
    persistMessage: (input, senderId) =>
      Promise.resolve({
        created: true,
        message: {
          id: input.message_id ?? randomUUID(),
          senderId,
          conversationId: input.conversation_id,
          content: input.content,
          createdAt: new Date("2026-09-12T20:00:00.000Z"),
        },
      }),
  };

  return {
    authenticate: vi.fn(defaults.authenticate),
    persistMessage: vi.fn(defaults.persistMessage),
    ...overrides,
  };
}

describe("handleFrame", () => {
  it("requires a successful auth frame first", async () => {
    const deps = dependencies();
    const unauthenticated = await handleFrame(
      frame({
        type: "message",
        messageId: randomUUID(),
        conversationId: randomUUID(),
        content: "Hello",
      }),
      false,
      undefined,
      deps,
    );
    expect(unauthenticated.response).toMatchObject({
      type: "error",
      code: "AUTH_REQUIRED",
    });

    const authenticated = await handleFrame(
      frame({ type: "auth", accessToken: "valid-token" }),
      false,
      undefined,
      deps,
    );
    expect(authenticated).toEqual({
      response: { type: "auth_ack" },
      authenticatedUser: user,
    });
    expect(deps.authenticate).toHaveBeenCalledWith("valid-token");
  });

  it("rejects invalid authentication", async () => {
    const result = await handleFrame(
      frame({ type: "auth", accessToken: "expired" }),
      false,
      undefined,
      dependencies({ authenticate: () => Promise.resolve(null) }),
    );
    expect(result.response).toMatchObject({
      type: "error",
      code: "AUTH_FAILED",
    });
  });

  it("persists before acknowledging with the canonical message", async () => {
    const messageId = randomUUID();
    const conversationId = randomUUID();
    let resolvePersistence:
      | ((
          value: Awaited<ReturnType<FrameDependencies["persistMessage"]>>,
        ) => void)
      | undefined;
    const persistence = new Promise<
      Awaited<ReturnType<FrameDependencies["persistMessage"]>>
    >((resolve) => {
      resolvePersistence = resolve;
    });

    const pending = handleFrame(
      frame({
        type: "message",
        messageId,
        conversationId,
        content: "Hello",
      }),
      false,
      user,
      dependencies({ persistMessage: async () => await persistence }),
    );
    let acknowledged = false;
    void pending.then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);

    const persisted = {
      id: messageId,
      senderId: user.id,
      conversationId,
      content: "Hello",
      createdAt: new Date("2026-09-12T20:00:00.000Z"),
    };
    resolvePersistence?.({ created: true, message: persisted });

    expect((await pending).response).toEqual({
      type: "ack",
      messageId,
      status: "accepted",
      message: persisted,
    });
  });

  it("maps message ID conflicts", async () => {
    const result = await handleFrame(
      frame({
        type: "message",
        messageId: randomUUID(),
        conversationId: randomUUID(),
        content: "Different",
      }),
      false,
      user,
      dependencies({
        persistMessage: () => Promise.reject(new MessageIdConflictError()),
      }),
    );
    expect(result.response).toMatchObject({
      type: "error",
      code: "MESSAGE_ID_CONFLICT",
    });
  });

  it("rejects malformed JSON", async () => {
    expect(
      (await handleFrame(Buffer.from("{"), false, undefined, dependencies()))
        .response,
    ).toEqual({
      type: "error",
      code: "MALFORMED_JSON",
      message: "Message must be valid JSON",
    });
  });

  it("rejects binary frames", async () => {
    expect(
      (
        await handleFrame(
          Buffer.from("ignored"),
          true,
          undefined,
          dependencies(),
        )
      ).response,
    ).toEqual({
      type: "error",
      code: "BINARY_NOT_SUPPORTED",
      message: "Only JSON text messages are supported",
    });
  });

  it("returns safe validation details and a valid messageId", async () => {
    const messageId = randomUUID();
    const { response } = await handleFrame(
      frame({
        type: "message",
        messageId,
        conversationId: "not-a-uuid",
        content: "   ",
      }),
      false,
      user,
      dependencies(),
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

  it("does not echo an invalid messageId", async () => {
    const { response } = await handleFrame(
      frame({
        type: "message",
        messageId: "not-a-uuid",
        conversationId: randomUUID(),
        content: "Hello",
      }),
      false,
      user,
      dependencies(),
    );

    expect(response).not.toHaveProperty("messageId");
  });

  it("rejects content longer than the configured limit", async () => {
    const { response } = await handleFrame(
      frame({
        type: "message",
        messageId: randomUUID(),
        conversationId: randomUUID(),
        content: "a".repeat(MAX_CONTENT_LENGTH + 1),
      }),
      false,
      user,
      dependencies(),
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

  it("rejects application frames over the byte limit", async () => {
    const { response } = await handleFrame(
      Buffer.alloc(MAX_FRAME_BYTES + 1, "a"),
      false,
      user,
      dependencies(),
    );

    expect(response).toMatchObject({
      type: "error",
      code: "FRAME_TOO_LARGE",
    });
  });
});
