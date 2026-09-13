import { describe, expect, it } from "vitest";

import {
  DEFAULT_KAFKA_CLIENT_ID,
  readKafkaConnectionConfig,
  toKafkaJsClientConfig,
} from "../src/kafka/config.js";

describe("Kafka connection config", () => {
  it("omits SASL for local plaintext brokers", () => {
    const config = readKafkaConnectionConfig({
      KAFKA_BROKERS: "localhost:9092",
    });

    expect(config).toEqual({
      clientId: DEFAULT_KAFKA_CLIENT_ID,
      brokers: ["localhost:9092"],
      ssl: false,
    });
    expect(toKafkaJsClientConfig(config)).toEqual({
      kafkaJS: {
        clientId: DEFAULT_KAFKA_CLIENT_ID,
        brokers: ["localhost:9092"],
      },
    });
  });

  it("requires API credentials when SSL is enabled", () => {
    expect(() =>
      readKafkaConnectionConfig({
        KAFKA_BROKERS: "pkc.example.confluent.cloud:9092",
        KAFKA_SSL: "true",
      }),
    ).toThrow(
      "KAFKA_API_KEY and KAFKA_API_SECRET are required when KAFKA_SSL=true",
    );
  });

  it("sets SASL PLAIN for Confluent Cloud", () => {
    const config = readKafkaConnectionConfig({
      KAFKA_BROKERS: "pkc.example.confluent.cloud:9092",
      KAFKA_SSL: "true",
      KAFKA_API_KEY: "cluster-key",
      KAFKA_API_SECRET: "cluster-secret",
      KAFKA_CLIENT_ID: "chitchat-message-service",
    });

    expect(toKafkaJsClientConfig(config)).toEqual({
      kafkaJS: {
        clientId: "chitchat-message-service",
        brokers: ["pkc.example.confluent.cloud:9092"],
        ssl: true,
        sasl: {
          mechanism: "plain",
          username: "cluster-key",
          password: "cluster-secret",
        },
      },
    });
  });

  it("rejects missing brokers", () => {
    expect(() => readKafkaConnectionConfig({})).toThrow(
      "KAFKA_BROKERS is required",
    );
  });
});
