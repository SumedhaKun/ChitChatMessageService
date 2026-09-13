import "dotenv/config";

import { createMessageHttpServer } from "../src/server.js";

const server = createMessageHttpServer();

export default server;
