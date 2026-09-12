import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import WebSocket, { type RawData, type WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeMessageServer,
  createMessageServer,
  type Logger,
} from "../src/server.js";
import { MAX_TRANSPORT_FRAME_BYTES } from "../src/protocol.js";

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

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

describe("WebSocket message server", () => {
  let server: WebSocketServer;
  let url: string;

  beforeAll(async () => {
    server = createMessageServer({ port: 0, logger: silentLogger });
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

    client.send(
      JSON.stringify({
        type: "message",
        messageId,
        conversationId: randomUUID(),
        content: "Hello over WebSocket",
      }),
    );

    await expect(receiveJson(client)).resolves.toEqual({
      type: "ack",
      messageId,
      status: "accepted",
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
});
