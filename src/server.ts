import "dotenv/config";

import { createServer, type Server as HttpServer } from "node:http";
import { pathToFileURL } from "node:url";

import { createHttpApp } from "./api/app.js";
import { createSupabaseAuthenticator, type Authenticate } from "./auth.js";
import {
  closeDatabaseConnection,
  getDatabaseConnection,
  type Database,
} from "./db/client.js";
import type { PublishMessageCreated } from "./kafka/publisher.js";

const DEFAULT_PORT = 8_080;

export interface Logger {
  info(event: Record<string, unknown>): void;
  warn(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

export interface ServerOptions {
  logger?: Logger;
  authenticate?: Authenticate;
  getDatabase?: () => Database;
  publishMessageCreated?: PublishMessageCreated;
}

export function readPort(value = process.env.PORT): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function createMessageHttpServer(
  options: ServerOptions = {},
): HttpServer {
  const logger = options.logger ?? console;
  return createServer(
    createHttpApp({
      logger,
      authenticate: options.authenticate ?? createSupabaseAuthenticator(),
      getDatabase: options.getDatabase ?? (() => getDatabaseConnection().db),
      ...(options.publishMessageCreated === undefined
        ? {}
        : { publishMessageCreated: options.publishMessageCreated }),
    }),
  );
}

export async function closeMessageHttpServer(
  server: HttpServer,
): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }

  await closeDatabaseConnection();
  const { closeMessageCreatedPublisher } = await import("./kafka/client.js");
  await closeMessageCreatedPublisher();
}

function run(): void {
  const logger: Logger = console;
  const server = createMessageHttpServer({ logger });
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: "server_shutdown_started", signal });

    void closeMessageHttpServer(server)
      .then(() => logger.info({ event: "server_shutdown_complete" }))
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
  server.listen(readPort(), () => {
    logger.info({ event: "server_listening", port: readPort() });
  });
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  run();
}
