import "dotenv/config";

import { createServiceServers } from "../src/server.js";

const { httpServer: server } = createServiceServers();

export default server;
