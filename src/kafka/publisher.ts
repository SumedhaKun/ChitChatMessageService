import type { MessageRow } from "../db/schema.js";
import { MESSAGE_CREATED_TOPIC } from "./config.js";
import { toMessageCreatedEvent } from "./event.js";

export type PublishMessageCreated = (message: MessageRow) => Promise<void>;

export interface KafkaProducerClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(record: {
    topic: string;
    messages: Array<{ key: string; value: string }>;
  }): Promise<unknown>;
}

export interface MessageCreatedPublisher {
  publish: PublishMessageCreated;
  disconnect(): Promise<void>;
}

export function createMessageCreatedPublisher(
  producer: KafkaProducerClient,
): MessageCreatedPublisher {
  let connectAttempt: Promise<void> | undefined;

  async function ensureConnected(): Promise<void> {
    if (connectAttempt === undefined) {
      connectAttempt = producer.connect().catch((error: unknown) => {
        connectAttempt = undefined;
        throw error;
      });
    }

    await connectAttempt;
  }

  return {
    async publish(message) {
      await ensureConnected();
      const event = toMessageCreatedEvent(message);
      await producer.send({
        topic: MESSAGE_CREATED_TOPIC,
        messages: [
          {
            key: event.conversationId,
            value: JSON.stringify(event),
          },
        ],
      });
    },
    async disconnect() {
      if (connectAttempt === undefined) {
        return;
      }

      await connectAttempt.catch(() => undefined);
      connectAttempt = undefined;
      await producer.disconnect();
    },
  };
}
