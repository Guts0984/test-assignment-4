// Starts the standalone Next.js server and makes it stop politely.
//
// On SIGTERM: stop accepting new connections, let requests that are running finish, then exit with code 0.
// (Next's standalone server.js does not do this by itself, and would be killed by the signal.)
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

let server;
let stopping = false;

// Next creates its HTTP server inside server.js and does not hand it back, so we note it as it is created.
const createServer = http.createServer;
http.createServer = (...args) => {
  server = createServer.apply(http, args);
  server.on("request", (req, res) => {
    // Requests that start while stopping ask the client not to reuse the connection...
    if (stopping) res.setHeader("Connection", "close");
    // ...and any connection that finishes an answer while stopping is closed after it (end() sends what is
    // still waiting first, so an answer is never cut short).
    res.on("finish", () => {
      if (stopping) req.socket.end();
    });
  });
  return server;
};

const stop = (signal) => {
  if (stopping || !server) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", service: "web", msg: "shutdown started", signal }));
  const forced = setTimeout(() => {
    console.log(JSON.stringify({ level: "warn", service: "web", msg: "requests did not finish in time, closing" }));
    server.closeAllConnections();
  }, Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000));
  forced.unref();
  server.close(() => {
    console.log(JSON.stringify({ level: "info", service: "web", msg: "shutdown finished" }));
    process.exit(0);
  });
  server.closeIdleConnections();
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

await import(path.join(path.dirname(fileURLToPath(import.meta.url)), "apps/web/server.js"));
