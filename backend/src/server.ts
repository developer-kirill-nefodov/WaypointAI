import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { env } from "./config/env.js";
import { database } from "./database/client.js";
import { apiRouter } from "./api/http.js";
import { attachWebSocket } from "./api/websocket.js";

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: env.FRONTEND_ORIGIN, methods: ["GET", "POST", "DELETE"] }));
app.use(express.json({ limit: "32kb" }));
app.use("/api/v1", apiRouter);
app.use((_request, response) => response.status(404).json({ error: "not_found" }));
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled request error", error);
  response.status(500).json({ error: "internal_error" });
});

const server = createServer(app);
attachWebSocket(server);
server.listen(env.API_PORT, env.API_HOST, () => {
  console.log(`Waypoint AI API listening on http://${env.API_HOST}:${env.API_PORT}`);
  void database.authenticate().catch(() => console.warn("PostgreSQL is not available yet; start it and apply migrations."));
});

async function shutdown(): Promise<void> {
  server.close();
  await database.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
