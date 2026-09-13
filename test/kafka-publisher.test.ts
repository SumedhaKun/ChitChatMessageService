import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { MESSAGE_CREATED_TOPIC } from "../src/kafka/config.js";
import { createMessageCreatedPublisher } from "../src/kafka/publisher.js";
import type { MessageRow } from "../src/db/schema.js";

const message: MessageRow = {
  id: randomUUID(),
  senderId: randomUUID(),
  conversationId: randomUUID(),
  content: "Hello",
  createdAt: new Date("2026-09-12T20:00:00.000Z"),
};

function fakeProducer(
  overrides: Partial<{
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
    send: (record: {
      topic: string;
      messages: Array<{ key: string; value: string }>;
    }) => Promise<unknown>;
  }> = {},
) {
  return {
    connect: vi.fn(overrides.connect ?? (() => Promise.resolve())),
    disconnect: vi.fn(overrides.disconnect ?? (() => Promise.resolve())),
    send: vi.fn(overrides.send ?? (() => Promise.resolve([]))),
  };
}

describe("messageCreated publisher", () => {
  it("produces JSON to messageCreated keyed by conversationId", async () => {
    const producer = fakeProducer();
    const publisher = createMessageCreatedPublisher(producer);

    await publisher.publish(message);

    expect(producer.connect).toHaveBeenCalledOnce();
    expect(producer.send).toHaveBeenCalledWith({
      topic: MESSAGE_CREATED_TOPIC,
      messages: [
        {
          key: message.conversationId,
          value: JSON.stringify({
            messageId: message.id,
            senderId: message.senderId,
            conversationId: message.conversationId,
            content: "Hello",
            createdAt: "2026-09-12T20:00:00.000Z",
          }),
        },
      ],
    });
  });

  it("rejects when send rejects", async () => {
    const producer = fakeProducer({
      send: () => Promise.reject(new Error("broker down")),
    });
    const publisher = createMessageCreatedPublisher(producer);

    await expect(publisher.publish(message)).rejects.toThrow("broker down");
  });
});
