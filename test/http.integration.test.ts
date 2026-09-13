import { randomUUID } from "node:crypto";

import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { createHttpApp } from "../src/api/app.js";
import {
  createDatabaseConnection,
  type DatabaseConnection,
} from "../src/db/client.js";
import { runDatabaseMigrations } from "../src/db/migrations.js";
import { conversation } from "../src/db/schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  databaseUrl === undefined ? describe.skip : describe;

const createdConversationResponseSchema = z.object({
  conversation: z.object({
    id: z.uuid(),
    isGroup: z.boolean(),
    members: z.array(z.object({ userId: z.uuid() })),
  }),
});

const messagePageResponseSchema = z.object({
  messages: z.array(
    z.object({
      id: z.uuid(),
      senderId: z.uuid(),
      conversationId: z.uuid(),
      content: z.string(),
    }),
  ),
  next_cursor: z.string().nullable(),
});

describeWithDatabase("conversation and message HTTP API", () => {
  let connection: DatabaseConnection;
  let app: ReturnType<typeof createHttpApp>;

  beforeAll(async () => {
    connection = createDatabaseConnection(databaseUrl ?? "");
    await runDatabaseMigrations(connection.db);
    app = createHttpApp({
      getDatabase: () => connection.db,
      authenticate: (token) =>
        Promise.resolve({
          id: token,
          email: "person@example.com",
        }),
    });
  });

  afterEach(async () => {
    await connection.db.delete(conversation);
  });

  afterAll(async () => {
    await connection.sql.end();
  });

  it("creates a conversation, inserts a member message, and lists it", async () => {
    const userId = randomUUID();
    const conversationResponse = await request(app)
      .post("/conversation")
      .set("authorization", `Bearer ${userId}`)
      .send({
        name: "Friends",
        is_group: true,
        user_ids: [userId],
      })
      .expect(201);
    const created = createdConversationResponseSchema.parse(
      JSON.parse(conversationResponse.text) as unknown,
    );
    expect(created.conversation.members).toHaveLength(1);
    expect(created.conversation).toMatchObject({ isGroup: true });

    await request(app)
      .post("/message")
      .set("authorization", `Bearer ${userId}`)
      .send({
        conversation_id: created.conversation.id,
        message_id: randomUUID(),
        content: "Hello",
      })
      .expect(201);

    const listResponse = await request(app)
      .get(`/conversation/${created.conversation.id}/messages`)
      .set("authorization", `Bearer ${userId}`)
      .expect(200);
    const page = messagePageResponseSchema.parse(
      JSON.parse(listResponse.text) as unknown,
    );
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      senderId: userId,
      conversationId: created.conversation.id,
      content: "Hello",
    });
    expect(page.next_cursor).toBeNull();

    const conversationsResponse = await request(app)
      .get("/conversations")
      .set("authorization", `Bearer ${userId}`)
      .expect(200);
    expect(
      (conversationsResponse.body as { conversations: unknown }).conversations,
    ).toEqual([
      expect.objectContaining({
        id: created.conversation.id,
        isGroup: true,
        memberIds: [userId],
      }),
    ]);
  });

  it("returns missing-conversation and non-member errors", async () => {
    await request(app)
      .post("/message")
      .set("authorization", `Bearer ${randomUUID()}`)
      .send({
        conversation_id: randomUUID(),
        content: "Missing",
      })
      .expect(404);

    const memberId = randomUUID();
    const conversationResponse = await request(app)
      .post("/conversation")
      .set("authorization", `Bearer ${memberId}`)
      .send({ is_group: false, user_ids: [randomUUID()] })
      .expect(201);
    const created = createdConversationResponseSchema.parse(
      JSON.parse(conversationResponse.text) as unknown,
    );

    await request(app)
      .post("/message")
      .set("authorization", `Bearer ${randomUUID()}`)
      .send({
        conversation_id: created.conversation.id,
        content: "Forbidden",
      })
      .expect(403);
  });

  it("rejects malformed payloads and cursors", async () => {
    await request(app)
      .post("/conversation")
      .set("authorization", `Bearer ${randomUUID()}`)
      .set("content-type", "application/json")
      .send("{")
      .expect(400);

    const conversationResponse = await request(app)
      .post("/conversation")
      .set("authorization", `Bearer ${randomUUID()}`)
      .send({ is_group: false, user_ids: [randomUUID()] })
      .expect(201);
    const created = createdConversationResponseSchema.parse(
      JSON.parse(conversationResponse.text) as unknown,
    );

    await request(app)
      .get(`/conversation/${created.conversation.id}/messages?cursor=invalid`)
      .set("authorization", `Bearer ${randomUUID()}`)
      .expect(400);
  });

  it("requires REST bearer authentication and message-list membership", async () => {
    await request(app).get("/conversations").expect(401);

    const memberId = randomUUID();
    const conversationResponse = await request(app)
      .post("/conversation")
      .set("authorization", `Bearer ${memberId}`)
      .send({ is_group: false, user_ids: [randomUUID()] })
      .expect(201);
    const created = createdConversationResponseSchema.parse(
      JSON.parse(conversationResponse.text) as unknown,
    );

    await request(app)
      .get(`/conversation/${created.conversation.id}/messages`)
      .set("authorization", `Bearer ${randomUUID()}`)
      .expect(403);
  });
});

describe("REST CORS", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows configured origins and omits CORS headers for other origins", async () => {
    vi.stubEnv(
      "CLIENT_ORIGIN",
      "https://client.example.com, https://preview.example.com",
    );
    const app = createHttpApp({
      authenticate: () => Promise.resolve(null),
      getDatabase: () => {
        throw new Error("Database should not be used");
      },
    });

    const allowed = await request(app)
      .options("/conversation")
      .set("origin", "https://client.example.com")
      .set("access-control-request-method", "POST")
      .expect(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "https://client.example.com",
    );

    const denied = await request(app)
      .options("/conversation")
      .set("origin", "https://attacker.example.com")
      .set("access-control-request-method", "POST")
      .expect(204);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("REST authentication", () => {
  it("rejects missing and invalid bearer tokens without touching the DB", async () => {
    const app = createHttpApp({
      authenticate: () => Promise.resolve(null),
      getDatabase: () => {
        throw new Error("Database should not be used");
      },
    });

    await request(app)
      .get("/conversations")
      .expect(401, {
        error: {
          code: "AUTH_REQUIRED",
          message: "Authorization Bearer token is required",
        },
      });
    await request(app)
      .get("/conversations")
      .set("authorization", "Bearer invalid")
      .expect(401, {
        error: {
          code: "AUTH_FAILED",
          message: "Access token is invalid or expired",
        },
      });
  });
});
