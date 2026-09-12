import { createServer } from "node:http";

import { createMessageServer } from "../src/server.js";

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: "ok" }));
});

createMessageServer({ httpServer: server });

export default server;
