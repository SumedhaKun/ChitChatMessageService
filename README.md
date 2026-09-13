# ChitChat Message Service

Owns conversation membership and persisted messages in PostgreSQL. It also
provides a WebSocket endpoint that authenticates, validates, persists, and
acknowledges messages. REST and WebSocket identities are verified with Supabase
JWTs; caller-provided sender IDs are never trusted.

## Requirements

- Node.js 22
- npm
- PostgreSQL 16 or a Supabase Postgres database

## Local setup

The existing `chitchatstorageservice-postgres-1` container exposes the expected
database at `localhost:5432`.

```sh
nvm use
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

The HTTP and WebSocket server listens on port `8080` by default. `DATABASE_URL`,
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `CLIENT_ORIGIN`, and `PORT` are loaded
from `.env`. `CLIENT_ORIGIN` defaults to `http://localhost:3000`; use a
comma-separated list to allow multiple client origins.

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

## WebSocket contract

Connect locally to `ws://localhost:8080` or on Render to
`wss://your-message-service.onrender.com`. The first frame must authenticate:

```json
{ "type": "auth", "accessToken": "<supabase-access-token>" }
```

Successful authentication returns `{ "type": "auth_ack" }`. Message frames
before authentication return `AUTH_REQUIRED`. After authentication, send:

```json
{
  "type": "message",
  "messageId": "6d08ce26-b21c-436c-a93e-3b82e575a662",
  "conversationId": "bf22c071-69ee-4bd5-a7c6-6d1d221bbef6",
  "content": "Hello"
}
```

A valid frame receives:

```json
{
  "type": "ack",
  "messageId": "6d08ce26-b21c-436c-a93e-3b82e575a662",
  "status": "accepted",
  "message": {
    "id": "6d08ce26-b21c-436c-a93e-3b82e575a662",
    "senderId": "493894c2-e0f6-4b24-87d1-354ecd66746d",
    "conversationId": "bf22c071-69ee-4bd5-a7c6-6d1d221bbef6",
    "content": "Hello",
    "createdAt": "2026-09-12T20:00:00.000Z"
  }
}
```

The client `messageId` is the database primary key. Acknowledgments are sent
only after commit and contain the canonical persisted row. Identical retries
return the existing row; mismatched reuse returns `MESSAGE_ID_CONFLICT`.
Text frames above 16 KiB receive `FRAME_TOO_LARGE`; frames above 32 KiB close
with code `1009`.

## Supabase and Render

`render.yaml` defines a free Render web service. Create a Blueprint from this
repository and provide `DATABASE_URL`, `SUPABASE_URL`, and
`SUPABASE_ANON_KEY` when prompted. Set `CLIENT_ORIGIN` to the production Vercel
client origin without a trailing slash. Render supplies `PORT`; do not set it
manually. For runtime traffic, use the Supabase transaction-pooler connection
string with SSL enabled.

Free Render services do not support pre-deploy commands, so apply migrations
manually before each deployment:

```sh
DATABASE_URL="<supabase migration connection string>" npm run db:migrate
```

After the service is deployed, use its HTTPS origin for REST requests and its
WSS origin for WebSocket connections:

```sh
NEXT_PUBLIC_MESSAGE_SERVICE_URL=https://your-message-service.onrender.com
NEXT_PUBLIC_MESSAGE_SERVER_URL=wss://your-message-service.onrender.com
```

Render free services spin down after 15 minutes without inbound HTTP requests
or WebSocket messages and can take about a minute to wake. Render can also
replace instances during deploys or maintenance, so clients must reconnect with
backoff. Use an always-on Render plan before depending on real-time
availability.

The Vercel adapter and `vercel.json` remain available as a rollback path.

## Operational behavior

`GET /health` and `GET /api/server` return `{ "status": "ok" }`. The service
logs lifecycle and failure metadata without logging message content. Local
`SIGINT` or `SIGTERM` shutdown closes HTTP, WebSocket, and database resources.
