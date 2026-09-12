# ChitChat Message Service

A stateless WebSocket service that validates incoming chat messages and
acknowledges accepted payloads. This version does not authenticate, persist, or
relay messages.

## Requirements

- Node.js 22 or newer
- npm

## Run locally

```sh
nvm use
npm install
npm run dev
```

The server listens on port `8080` by default. Set `PORT` to use another port:

```sh
PORT=3000 npm run dev
```

Useful commands:

```sh
npm test
npm run lint
npm run format:check
npm run build
npm start
```

## WebSocket contract

Connect to `ws://localhost:8080` and send a JSON text frame:

```json
{
  "type": "message",
  "messageId": "6d08ce26-b21c-436c-a93e-3b82e575a662",
  "conversationId": "bf22c071-69ee-4bd5-a7c6-6d1d221bbef6",
  "content": "Hello"
}
```

Both IDs must be UUIDs. `content` is trimmed for validation and must contain
between 1 and 4,000 characters. Extra fields are rejected.

A valid message receives:

```json
{
  "type": "ack",
  "messageId": "6d08ce26-b21c-436c-a93e-3b82e575a662",
  "status": "accepted"
}
```

An invalid message receives a stable error envelope:

```json
{
  "type": "error",
  "code": "VALIDATION_ERROR",
  "message": "Message payload is invalid",
  "messageId": "6d08ce26-b21c-436c-a93e-3b82e575a662",
  "details": [
    {
      "field": "conversationId",
      "message": "Invalid UUID"
    }
  ]
}
```

The possible error codes are:

- `BINARY_NOT_SUPPORTED`
- `FRAME_TOO_LARGE`
- `MALFORMED_JSON`
- `VALIDATION_ERROR`

The service returns `messageId` in an error only if it is itself a valid UUID.
Text frames above 16 KiB receive `FRAME_TOO_LARGE`; the WebSocket transport
closes frames above 32 KiB with close code `1009`.

## Example client

Run this in a browser console:

```js
const socket = new WebSocket("ws://localhost:8080");

socket.addEventListener("open", () => {
  socket.send(
    JSON.stringify({
      type: "message",
      messageId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      content: "Hello",
    }),
  );
});

socket.addEventListener("message", (event) => {
  console.log(JSON.parse(event.data));
});
```

## Deploy to Vercel

Import the GitHub repository into Vercel or deploy it with the Vercel CLI:

```sh
npx vercel
npx vercel --prod
```

Fluid Compute is enabled in `vercel.json`, as required by Vercel WebSockets.
After deployment, connect to:

```text
wss://your-domain.vercel.app/api/server
```

Opening `https://your-domain.vercel.app/api/server` without a WebSocket upgrade
returns `{ "status": "ok" }`.

Vercel WebSocket support is currently in public beta and requires WebSocket
permissions on the Vercel account. Connections close when the Function reaches
its maximum duration (configured to 300 seconds), so production clients must
reconnect with backoff after a close event.

## Operational behavior

The server logs structured connection lifecycle and rejection events. Message
content is never logged. On `SIGINT` or `SIGTERM`, it stops accepting
connections, closes active clients, and exits after graceful shutdown.
