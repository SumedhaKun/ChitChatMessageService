import "dotenv/config";

import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { pathToFileURL } from "node:url";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { createHttpApp } from "./api/app.js";
import {
  createSupabaseAuthenticator,
  type Authenticate,
  type AuthenticatedUser,
} from "./auth.js";
import {
  closeDatabaseConnection,
  getDatabaseConnection,
  type Database,
} from "./db/client.js";
import { persistAndPublishMessage } from "./kafka/persist.js";
import type { PublishMessageCreated } from "./kafka/publisher.js";
import { handleFrame, type PersistMessage } from "./message-handler.js";
import { MAX_TRANSPORT_FRAME_BYTES } from "./protocol.js";

const DEFAULT_PORT = 8_080;
const SHUTDOWN_TIMEOUT_MS = 5_000;

export interface Logger {
  info(event: Record<string, unknown>): void;
  warn(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

export interface ServerOptions {
  port?: number;
  httpServer?: HttpServer;
  logger?: Logger;
  authenticate?: Authenticate;
  getDatabase?: () => Database;
  persistMessage?: PersistMessage;
  publishMessageCreated?: PublishMessageCreated;
}

export interface ServiceServers {
  httpServer: HttpServer;
  webSocketServer: WebSocketServer;
}

export interface ServiceServerOptions {
  logger?: Logger;
  authenticate?: Authenticate;
  getDatabase?: () => Database;
  persistMessage?: PersistMessage;
  publishMessageCreated?: PublishMessageCreated;
}

export function readPort(value = process.env.PORT): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return port;
}

function defaultPublishMessageCreated(): PublishMessageCreated {
  return async (message) => {
    const { getMessageCreatedPublisher } = await import("./kafka/client.js");
    await getMessageCreatedPublisher().publish(message);
  };
}

function defaultPersistMessage(
  getDatabase: () => Database,
  publishMessageCreated: PublishMessageCreated,
): PersistMessage {
  return async (input, senderId) =>
    await persistAndPublishMessage(
      getDatabase(),
      publishMessageCreated,
      input,
      senderId,
    );
}

function normalizeRawData(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

export function createMessageServer(
  options: ServerOptions = {},
): WebSocketServer {
  const logger = options.logger ?? console;
  const authenticate = options.authenticate ?? createSupabaseAuthenticator();
  const getDatabase = options.getDatabase ?? (() => getDatabaseConnection().db);
  const persistMessage =
    options.persistMessage ??
    defaultPersistMessage(
      getDatabase,
      options.publishMessageCreated ?? defaultPublishMessageCreated(),
    );
  const server =
    options.httpServer === undefined
      ? new WebSocketServer({
          port: options.port ?? readPort(),
          maxPayload: MAX_TRANSPORT_FRAME_BYTES,
        })
      : new WebSocketServer({
          server: options.httpServer,
          maxPayload: MAX_TRANSPORT_FRAME_BYTES,
        });

  server.on("listening", () => {
    const address = server.address();
    logger.info({
      event: "server_listening",
      ...(typeof address === "object" && address !== null
        ? { port: address.port }
        : {}),
    });
  });

  server.on("connection", (socket) => {
    const connectionId = randomUUID();
    let authenticatedUser: AuthenticatedUser | undefined;
    let processing = Promise.resolve();
    logger.info({ event: "connection_opened", connectionId });

    socket.on("message", (data, isBinary) => {
      processing = processing
        .then(async () => {
          const result = await handleFrame(
            normalizeRawData(data),
            isBinary,
            authenticatedUser,
            {
              authenticate,
              persistMessage,
            },
          );
          authenticatedUser = result.authenticatedUser ?? authenticatedUser;

          if (result.response.type === "error") {
            logger.warn({
              event: "message_rejected",
              connectionId,
              code: result.response.code,
              ...(result.response.messageId === undefined
                ? {}
                : { messageId: result.response.messageId }),
            });
          }

          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(result.response));
          }
        })
        .catch((error: unknown) => {
          logger.error({
            event: "message_processing_failed",
            connectionId,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(
              JSON.stringify({
                type: "error",
                code: "INTERNAL_ERROR",
                message: "Internal server error",
              }),
            );
          }
        });
    });

    socket.on("error", (error) => {
      logger.warn({
        event: "connection_error",
        connectionId,
        error: error.message,
      });
    });

    socket.on("close", (code) => {
      logger.info({ event: "connection_closed", connectionId, code });
    });
  });

  server.on("error", (error) => {
    logger.error({ event: "server_error", error: error.message });
  });

  return server;
}

export function createServiceServers(
  options: ServiceServerOptions = {},
): ServiceServers {
  const logger = options.logger ?? console;
  const authenticate = options.authenticate ?? createSupabaseAuthenticator();
  const getDatabase = options.getDatabase ?? (() => getDatabaseConnection().db);
  const publishMessageCreated =
    options.publishMessageCreated ?? defaultPublishMessageCreated();
  const persistMessage =
    options.persistMessage ??
    defaultPersistMessage(getDatabase, publishMessageCreated);
  const httpServer = createServer(
    createHttpApp({
      logger,
      authenticate,
      getDatabase,
      publishMessageCreated,
    }),
  );
  const webSocketServer = createMessageServer({
    httpServer,
    logger,
    authenticate,
    getDatabase,
    persistMessage,
  });
  return { httpServer, webSocketServer };
}

export async function closeMessageServer(
  server: WebSocketServer,
): Promise<void> {
  for (const client of server.clients) {
    client.close(1001, "Server shutting down");
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      for (const client of server.clients) {
        client.terminate();
      }
    }, SHUTDOWN_TIMEOUT_MS);
    timeout.unref();

    server.close((error) => {
      clearTimeout(timeout);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

export async function closeServiceServers(
  servers: ServiceServers,
): Promise<void> {
  await closeMessageServer(servers.webSocketServer);

  if (servers.httpServer.listening) {
    await new Promise<void>((resolve, reject) => {
      servers.httpServer.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  await closeDatabaseConnection();
  const { closeMessageCreatedPublisher } = await import("./kafka/client.js");
  await closeMessageCreatedPublisher();
}

function run(): void {
  const logger: Logger = console;
  const servers = createServiceServers({ logger });
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ event: "server_shutdown_started", signal });

    void closeServiceServers(servers)
      .then(() => {
        logger.info({ event: "server_shutdown_complete" });
      })
      .catch((error: unknown) => {
        logger.error({
          event: "server_shutdown_failed",
          error: error instanceof Error ? error.message : "Unknown error",
        });
        process.exitCode = 1;
      });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  servers.httpServer.listen(readPort());
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  run();
}
