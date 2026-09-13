# ChitChat Message Service

Owns conversation membership and persisted messages in PostgreSQL. The HTTP
API authenticates with Supabase JWTs; caller-provided sender IDs are never
trusted.

## Requirements

- Node.js 22
- npm
- PostgreSQL 16 or a Supabase Postgres database
- A Kafka broker: local Docker for development, or Confluent Cloud cluster
  `chitchat_cluster` for production

## Local setup

The existing `chitchatstorageservice-postgres-1` container exposes the expected
database at `localhost:5432`.

```sh
nvm use
npm install
cp .env.example .env
docker compose up -d
npm run db:migrate
npm run dev
```

The HTTP server listens on port `8080` by default. `DATABASE_URL`,
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `CLIENT_ORIGIN`, `PORT`, and `KAFKA_BROKERS`
are loaded from `.env`. `CLIENT_ORIGIN` defaults to `http://localhost:3000`; use a
comma-separated list to allow multiple client origins.

Local Kafka listens on `localhost:9092` and seeds topic `messageCreated` with 6
partitions. After a message is persisted over REST, the service
publishes it to that topic with key `conversationId`. If produce fails, the
request fails so the client can retry; identical retries persist as HTTP 200 and
are published again. Delivery consumers should treat `messageId` as idempotent.

Useful commands:

```sh
npm run db:generate
npm run db:migrate
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
npm start
```

Set `TEST_DATABASE_URL` to run the PostgreSQL and HTTP integration tests.
Without it, those suites are skipped.

## REST API

All routes below require `Authorization: Bearer <supabase-access-token>`.

### Create a conversation

`POST /conversation`

```json
{
  "name": "Friends",
  "picture": "https://example.com/friends.png",
  "is_group": true,
  "user_ids": [
    "493894c2-e0f6-4b24-87d1-354ecd66746d",
    "6ad2cd82-7980-434c-b566-c063acdd9518"
  ]
}
```

`name` and `picture` are optional. `is_group` is required. The picture must be
an HTTP(S) URL. `user_ids` contains the other members and must contain at least
one UUID; duplicate IDs are removed. The authenticated caller is always added.
The conversation and all memberships are created atomically and returned with
HTTP 201.

### List conversations

`GET /conversations`

Returns conversations containing the authenticated caller, newest first. Each
conversation includes its normal camelCase database fields and `memberIds`
containing every member UUID:

```json
{
  "conversations": [
    {
      "id": "bf22c071-69ee-4bd5-a7c6-6d1d221bbef6",
      "name": "Friends",
      "picture": null,
      "isGroup": true,
      "createdAt": "2026-09-12T20:00:00.000Z",
      "memberIds": ["493894c2-e0f6-4b24-87d1-354ecd66746d"]
    }
  ]
}
```

### Create a message

`POST /message`

```json
{
  "message_id": "6d08ce26-b21c-436c-a93e-3b82e575a662",
  "conversation_id": "bf22c071-69ee-4bd5-a7c6-6d1d221bbef6",
  "content": "Hello"
}
```

The authenticated user is the sender and must be a conversation member.
`message_id` is an optional idempotency UUID. An identical retry returns the
persisted message with HTTP 200; mismatched reuse returns
`MESSAGE_ID_CONFLICT` with HTTP 409. A new message returns HTTP 201.

### List messages

`GET /conversation/:id/messages?limit=50&cursor=<opaque-cursor>`

Messages are returned newest first. `limit` defaults to 50 and may not exceed 100. When another page exists, pass the returned `next_cursor` unchanged:

```json
{
  "messages": [],
  "next_cursor": null
}
```

The authenticated caller must be a conversation member.

All database-backed response rows use camelCase field names, including
`senderId`, `conversationId`, and `createdAt`.

API errors use a consistent envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request body is invalid",
    "details": [{ "field": "content", "message": "Too small" }]
  }
}
```

## Supabase and Render

`render.yaml` defines a free Render web service. Create a Blueprint from this
repository and provide `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`CLIENT_ORIGIN`, `KAFKA_BROKERS`, `KAFKA_API_KEY`, and `KAFKA_API_SECRET` when
prompted. Set `CLIENT_ORIGIN` to the production Vercel client origin without a
trailing slash. Point Kafka at Confluent Cloud cluster `chitchat_cluster`: copy
the bootstrap server into `KAFKA_BROKERS`, keep `KAFKA_SSL=true`, and use a
cluster API key. Create topic `messageCreated` on that cluster with multiple
partitions before deploying; Confluent Cloud does not auto-create topics. Render
supplies `PORT`; do not set it manually. For runtime traffic, use the Supabase
transaction-pooler connection string with SSL enabled.

Free Render services do not support pre-deploy commands, so apply migrations
manually before each deployment:

```sh
DATABASE_URL="<supabase migration connection string>" npm run db:migrate
```

After the service is deployed, use its HTTPS origin for REST requests:

```sh
NEXT_PUBLIC_MESSAGE_SERVICE_URL=https://your-message-service.onrender.com
```

Render free services spin down after 15 minutes without inbound HTTP requests
and can take about a minute to wake.

The Vercel adapter and `vercel.json` remain available as a rollback path.

## Operational behavior

`GET /health` and `GET /api/server` return `{ "status": "ok" }`. The service
logs lifecycle and failure metadata without logging message content. Local
`SIGINT` or `SIGTERM` shutdown closes HTTP, database, and Kafka
producer resources.
