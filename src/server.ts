import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { pathToFileURL } from "node:url";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { handleFrame } from "./message-handler.js";
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
    logger.info({ event: "connection_opened", connectionId });

    socket.on("message", (data, isBinary) => {
      const response = handleFrame(normalizeRawData(data), isBinary);

      if (response.type === "error") {
        logger.warn({
          event: "message_rejected",
          connectionId,
          code: response.code,
          ...(response.messageId === undefined
            ? {}
            : { messageId: response.messageId }),
        });
      }

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(response));
      }
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

function run(): void {
  const logger: Logger = console;
  const server = createMessageServer({ logger });
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ event: "server_shutdown_started", signal });

    void closeMessageServer(server)
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
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  run();
}
