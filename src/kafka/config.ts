import type { KafkaJS } from "@confluentinc/kafka-javascript";

export const MESSAGE_CREATED_TOPIC = "messageCreated";
export const DEFAULT_KAFKA_CLIENT_ID = "chitchat-message-service";

export interface KafkaSaslPlain {
  mechanism: "plain";
  username: string;
  password: string;
}

export type KafkaConnectionConfig =
  | {
      clientId: string;
      brokers: string[];
      ssl: false;
    }
  | {
      clientId: string;
      brokers: string[];
      ssl: true;
      sasl: KafkaSaslPlain;
    };

export function parseKafkaBrokers(value: string | undefined): string[] {
  if (value === undefined) {
    throw new Error("KAFKA_BROKERS is required");
  }

  const brokers = value
    .split(",")
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);

  if (brokers.length === 0) {
    throw new Error("KAFKA_BROKERS is required");
  }

  return brokers;
}

export function kafkaSslEnabled(value: string | undefined): boolean {
  return value === "true";
}

export function readKafkaConnectionConfig(
  env: NodeJS.ProcessEnv = process.env,
): KafkaConnectionConfig {
  const brokers = parseKafkaBrokers(env.KAFKA_BROKERS);
  const clientId =
    env.KAFKA_CLIENT_ID === undefined || env.KAFKA_CLIENT_ID.length === 0
      ? DEFAULT_KAFKA_CLIENT_ID
      : env.KAFKA_CLIENT_ID;

  if (!kafkaSslEnabled(env.KAFKA_SSL)) {
    return {
      clientId,
      brokers,
      ssl: false,
    };
  }

  const username = env.KAFKA_API_KEY;
  const password = env.KAFKA_API_SECRET;
  if (
    username === undefined ||
    username.length === 0 ||
    password === undefined ||
    password.length === 0
  ) {
    throw new Error(
      "KAFKA_API_KEY and KAFKA_API_SECRET are required when KAFKA_SSL=true",
    );
  }

  return {
    clientId,
    brokers,
    ssl: true,
    sasl: {
      mechanism: "plain",
      username,
      password,
    },
  };
}

export function toKafkaJsClientConfig(
  config: KafkaConnectionConfig,
): KafkaJS.CommonConstructorConfig {
  if (config.ssl) {
    return {
      kafkaJS: {
        clientId: config.clientId,
        brokers: config.brokers,
        ssl: true,
        sasl: config.sasl,
      },
    };
  }

  return {
    kafkaJS: {
      clientId: config.clientId,
      brokers: config.brokers,
    },
  };
}
