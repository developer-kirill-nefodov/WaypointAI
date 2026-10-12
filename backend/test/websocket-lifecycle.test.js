import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { reconnectDelay, RECONNECT_MAX_DELAY_MS, WS_CLOSE_SERVICE_RESTART } from "../../packages/shared/src/reconnect.ts";
import { closeAllClients, startHeartbeat } from "../src/api/websocket-lifecycle.ts";

async function startServer() {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${http.address().port}`;
  return { wss, url, stop: () => new Promise((resolve) => { wss.close(); http.close(resolve); }) };
}

function connect(url, options) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url, options);
    client.once("open", () => resolve(client));
    client.once("error", reject);
  });
}

test("reconnect delays grow exponentially with jitter and are capped", () => {
  assert.equal(reconnectDelay(1, () => 0), 250);
  assert.equal(reconnectDelay(1, () => 1), 500);
  assert.equal(reconnectDelay(2, () => 1), 1000);
  assert.equal(reconnectDelay(4, () => 0.5), 3000);
  assert.equal(reconnectDelay(50, () => 1), RECONNECT_MAX_DELAY_MS);
  assert.ok(reconnectDelay(50, () => 0) >= RECONNECT_MAX_DELAY_MS / 2);
});

test("closes every client with the service-restart code before shutdown", async () => {
  const server = await startServer();
  const clients = await Promise.all([connect(server.url), connect(server.url)]);
  const codes = clients.map((client) => new Promise((resolve) => client.once("close", (code, reason) => resolve([code, String(reason)]))));
  await closeAllClients(server.wss, WS_CLOSE_SERVICE_RESTART, "Server restarting");
  assert.deepEqual(await Promise.all(codes), [[1012, "Server restarting"], [1012, "Server restarting"]]);
  await server.stop();
});

test("heartbeat keeps responsive clients and terminates silent ones", async () => {
  const server = await startServer();
  const stop = startHeartbeat(server.wss, 40);
  const responsive = await connect(server.url);
  // autoPong: false simulates a half-open connection that never answers pings.
  const silent = await connect(server.url, { autoPong: false });
  const silentClosed = new Promise((resolve) => silent.once("close", resolve));
  await silentClosed;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(responsive.readyState, WebSocket.OPEN);
  stop();
  responsive.close();
  await server.stop();
});

test("closing with no clients resolves immediately", async () => {
  const server = await startServer();
  await closeAllClients(server.wss, WS_CLOSE_SERVICE_RESTART, "Server restarting");
  await server.stop();
});
