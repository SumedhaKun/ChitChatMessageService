import { randomUUID } from "node:crypto";

import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHttpApp } from "../src/api/app.js";
import { createMessage } from "../src/api/repository.js";
import type { MessageRow } from "../src/db/schema.js";

vi.mock("../src/api/repository.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/api/repository.js")>();
  return {
    ...actual,
    createMessage: vi.fn(),
  };
});

const createMessageMock = vi.mocked(createMessage);

const userId = randomUUID();
const message: MessageRow = {
  id: randomUUID(),
  senderId: userId,
  conversationId: randomUUID(),
  content: "Hello",
  createdAt: new Date("2026-09-12T20:00:00.000Z"),
};

describe("POST /message Kafka publish", () => {
  beforeEach(() => {
    createMessageMock.mockReset();
  });

  it("publishes after persist and republishes identical retries", async () => {
    createMessageMock
      .mockResolvedValueOnce({ message, created: true })
      .mockResolvedValueOnce({ message, created: false });
    const published: MessageRow[] = [];
    const app = createHttpApp({
      authenticate: (token) =>
        Promise.resolve({ id: token, email: "person@example.com" }),
      getDatabase: () => ({}) as never,
      publishMessageCreated: (row) => {
        published.push(row);
        return Promise.resolve();
      },
    });
    const payload = {
      conversation_id: message.conversationId,
      message_id: message.id,
      content: "Hello",
    };

    await request(app)
      .post("/message")
      .set("authorization", `Bearer ${userId}`)
      .send(payload)
      .expect(201);
    await request(app)
      .post("/message")
      .set("authorization", `Bearer ${userId}`)
      .send(payload)
      .expect(200);

    expect(published).toEqual([message, message]);
  });

  it("returns 500 when publish fails after persist", async () => {
    createMessageMock.mockResolvedValue({ message, created: true });
    const app = createHttpApp({
      authenticate: (token) =>
        Promise.resolve({ id: token, email: "person@example.com" }),
      getDatabase: () => ({}) as never,
      publishMessageCreated: () => Promise.reject(new Error("broker down")),
    });

    await request(app)
      .post("/message")
      .set("authorization", `Bearer ${userId}`)
      .send({
        conversation_id: message.conversationId,
        content: "Hello",
      })
      .expect(500, {
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error",
        },
      });
  });
});
