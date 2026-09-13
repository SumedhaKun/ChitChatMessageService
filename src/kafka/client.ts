import { KafkaJS } from "@confluentinc/kafka-javascript";

import {
  readKafkaConnectionConfig,
  toKafkaJsClientConfig,
  type KafkaConnectionConfig,
} from "./config.js";
import {
  createMessageCreatedPublisher,
  type KafkaProducerClient,
  type MessageCreatedPublisher,
} from "./publisher.js";

const { Kafka } = KafkaJS;

let publisher: MessageCreatedPublisher | undefined;

export function createConfluentProducer(
  config: KafkaConnectionConfig = readKafkaConnectionConfig(),
): KafkaProducerClient {
  const kafka = new Kafka(toKafkaJsClientConfig(config));
  return kafka.producer({
    kafkaJS: {
      acks: -1,
    },
  });
}

export function getMessageCreatedPublisher(): MessageCreatedPublisher {
  if (publisher !== undefined) {
    return publisher;
  }

  publisher = createMessageCreatedPublisher(createConfluentProducer());
  return publisher;
}

export async function closeMessageCreatedPublisher(): Promise<void> {
  if (publisher === undefined) {
    return;
  }

  const current = publisher;
  publisher = undefined;
  await current.disconnect();
}
