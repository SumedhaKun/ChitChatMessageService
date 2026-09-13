import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import WebSocket, { type RawData, type WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeMessageServer,
  createMessageServer,
  type Logger,
  type ServerOptions,
} from "../src/server.js";
import { MAX_TRANSPORT_FRAME_BYTES } from "../src/protocol.js";

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const authenticatedUser = {
  id: randomUUID(),
  email: "person@example.com",
};

const injectedDependencies = {
  authenticate: (token: string) =>
    Promise.resolve(token === "valid-token" ? authenticatedUser : null),
  persistMessage: (input, senderId) =>
    Promise.resolve({
      created: true,
      message: {
        id: input.message_id ?? randomUUID(),
        senderId,
        conversationId: input.conversation_id,
        content: input.content,
        createdAt: new Date("2026-09-12T20:00:00.000Z"),
      },
    }),
} satisfies Pick<ServerOptions, "authenticate" | "persistMessage">;

async function waitForListening(server: WebSocketServer): Promise<void> {
  if (server.address() !== null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

async function openClient(url: string): Promise<WebSocket> {
  const client = new WebSocket(url);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    client.once("error", onError);
    client.once("open", () => {
      client.off("error", onError);
      resolve();
    });
  });

  return client;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

async function receiveJson(client: WebSocket): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    client.once("error", reject);
    client.once("message", (data) => {
      try {
        resolve(JSON.parse(rawDataToBuffer(data).toString("utf8")) as unknown);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Invalid response"));
      }
    });
  });
}

async function closeClient(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    client.once("close", () => resolve());
    if (client.readyState === WebSocket.OPEN) {
      client.close();
    }
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

describe("WebSocket message server", () => {
  let server: WebSocketServer;
  let url: string;

  beforeAll(async () => {
    server = createMessageServer({
      port: 0,
      logger: silentLogger,
      ...injectedDependencies,
    });
    await waitForListening(server);
    const address = server.address() as AddressInfo;
    url = `ws://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await closeMessageServer(server);
  });

  it("acknowledges valid messages over a real WebSocket", async () => {
    const client = await openClient(url);
    const messageId = randomUUID();
    const conversationId = randomUUID();

    client.send(JSON.stringify({ type: "auth", accessToken: "valid-token" }));
    await expect(receiveJson(client)).resolves.toEqual({
      type: "auth_ack",
    });

    client.send(
      JSON.stringify({
        type: "message",
        messageId,
        conversationId,
        content: "Hello over WebSocket",
      }),
    );

    await expect(receiveJson(client)).resolves.toEqual({
      type: "ack",
      messageId,
      status: "accepted",
      message: {
        id: messageId,
        senderId: authenticatedUser.id,
        conversationId,
        content: "Hello over WebSocket",
        createdAt: "2026-09-12T20:00:00.000Z",
      },
    });
    await closeClient(client);
  });

  it("rejects message frames before authentication", async () => {
    const client = await openClient(url);
    const messageId = randomUUID();
    client.send(
      JSON.stringify({
        type: "message",
        messageId,
        conversationId: randomUUID(),
        content: "Too early",
      }),
    );

    await expect(receiveJson(client)).resolves.toMatchObject({
      type: "error",
      code: "AUTH_REQUIRED",
      messageId,
    });
    await closeClient(client);
  });

  it("returns structured errors over a real WebSocket", async () => {
    const client = await openClient(url);
    client.send("{");

    await expect(receiveJson(client)).resolves.toEqual({
      type: "error",
      code: "MALFORMED_JSON",
      message: "Message must be valid JSON",
    });
    await closeClient(client);
  });

  it("hard-limits frames above the transport maximum", async () => {
    const client = await openClient(url);
    client.send("a".repeat(MAX_TRANSPORT_FRAME_BYTES + 1));

    const closeCode = await new Promise<number>((resolve, reject) => {
      client.once("error", reject);
      client.once("close", (code) => resolve(code));
    });

    expect(closeCode).toBe(1009);
  });

  it("attaches to an existing HTTP server for hosted deployments", async () => {
    const httpServer = createServer();
    const webSocketServer = createMessageServer({
      httpServer,
      logger: silentLogger,
      ...injectedDependencies,
    });
    httpServer.listen(0, "127.0.0.1");
    await waitForListening(webSocketServer);

    const address = httpServer.address() as AddressInfo;
    const client = await openClient(
      `ws://127.0.0.1:${address.port}/api/server`,
    );
    const messageId = randomUUID();
    client.send(JSON.stringify({ type: "auth", accessToken: "valid-token" }));
    await receiveJson(client);
    client.send(
      JSON.stringify({
        type: "message",
        messageId,
        conversationId: randomUUID(),
        content: "Hosted transport",
      }),
    );

    await expect(receiveJson(client)).resolves.toMatchObject({
      type: "ack",
      messageId,
    });

    await closeClient(client);
    await closeMessageServer(webSocketServer);
    await closeHttpServer(httpServer);
  });
});
