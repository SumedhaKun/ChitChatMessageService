import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decodeMessageCursor, encodeMessageCursor } from "../src/api/cursor.js";
import {
  createConversationSchema,
  createMessageSchema,
  messageListQuerySchema,
} from "../src/api/schemas.js";

describe("REST API validation", () => {
  it("deduplicates conversation member IDs", () => {
    const userId = randomUUID();
    const result = createConversationSchema.parse({
      name: "Team",
      picture: "https://example.com/team.png",
      is_group: true,
      user_ids: [userId, userId],
    });

    expect(result.user_ids).toEqual([userId]);
  });

  it("rejects non-HTTP picture URLs", () => {
    expect(() =>
      createConversationSchema.parse({
        picture: "ftp://example.com/team.png",
        is_group: true,
        user_ids: [randomUUID()],
      }),
    ).toThrow();
  });

  it("trims message content", () => {
    const result = createMessageSchema.parse({
      message_id: randomUUID(),
      conversation_id: randomUUID(),
      content: "  Hello  ",
    });

    expect(result.content).toBe("Hello");
  });

  it("rejects caller-provided sender IDs", () => {
    expect(() =>
      createMessageSchema.parse({
        conversation_id: randomUUID(),
        sender_id: randomUUID(),
        content: "Hello",
      }),
    ).toThrow();
  });

  it("applies message list defaults and bounds", () => {
    expect(messageListQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(() => messageListQuerySchema.parse({ limit: 101 })).toThrow();
  });
});

describe("message cursor", () => {
  it("round-trips an opaque cursor", () => {
    const cursor = {
      id: randomUUID(),
      createdAt: new Date("2026-09-12T20:00:00.123Z"),
    };

    expect(decodeMessageCursor(encodeMessageCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed cursors", () => {
    expect(decodeMessageCursor("not-a-cursor")).toBeUndefined();
  });
});
