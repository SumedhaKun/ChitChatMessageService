import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMessage } from "../src/api/repository.js";
import type { Database } from "../src/db/client.js";
import type { MessageRow } from "../src/db/schema.js";
import { persistAndPublishMessage } from "../src/kafka/persist.js";

vi.mock("../src/api/repository.js", () => ({
  createMessage: vi.fn(),
}));

const createMessageMock = vi.mocked(createMessage);

const message: MessageRow = {
  id: randomUUID(),
  senderId: randomUUID(),
  conversationId: randomUUID(),
  content: "Hello",
  createdAt: new Date("2026-09-12T20:00:00.000Z"),
};

const input = {
  message_id: message.id,
  conversation_id: message.conversationId,
  content: message.content,
};

describe("persistAndPublishMessage", () => {
  beforeEach(() => {
    createMessageMock.mockReset();
  });

  it("publishes after persist including identical retries", async () => {
    createMessageMock
      .mockResolvedValueOnce({ message, created: true })
      .mockResolvedValueOnce({ message, created: false });
    const publish = vi.fn(() => Promise.resolve());
    const db = {} as Database;

    await persistAndPublishMessage(db, publish, input, message.senderId);
    await persistAndPublishMessage(db, publish, input, message.senderId);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenNthCalledWith(1, message);
    expect(publish).toHaveBeenNthCalledWith(2, message);
  });

  it("does not publish when persist fails", async () => {
    createMessageMock.mockRejectedValue(new Error("Conversation not found"));
    const publish = vi.fn(() => Promise.resolve());

    await expect(
      persistAndPublishMessage(
        {} as Database,
        publish,
        input,
        message.senderId,
      ),
    ).rejects.toThrow("Conversation not found");
    expect(publish).not.toHaveBeenCalled();
  });
});
