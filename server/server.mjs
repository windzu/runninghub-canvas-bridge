import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

const PORT = 8765;
const RUNTIME_PATH = new URL("./bridge-runtime.js", import.meta.url);
const events = [];
const pendingCommands = new Map();
const commandResults = new Map();

const json = (res, status, value) => {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(body);
};

const javascript = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": "no-store"
  });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return json(res, 200, { ok: true });
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (req.method === "GET" && url.pathname === "/bridge-runtime.js") {
      return javascript(res, 200, await readFile(RUNTIME_PATH, "utf8"));
    }

    if (req.method === "GET" && url.pathname === "/runtime-version") {
      const runtime = await stat(RUNTIME_PATH);
      return json(res, 200, { mtimeMs: runtime.mtimeMs, size: runtime.size });
    }

    if (req.method === "POST" && url.pathname === "/events") {
      const body = await readBody(req);
      const event = JSON.parse(body || "{}");
      events.push(event);
      if (events.length > 1000) events.splice(0, events.length - 1000);
      if (event.kind === "command.result" && event.commandId) commandResults.set(event.commandId, event);
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/events") {
      const since = Number(url.searchParams.get("since") || "0");
      return json(res, 200, events.filter((event) => Number(event.seq || 0) > since));
    }

    if (req.method === "POST" && url.pathname === "/command") {
      const body = await readBody(req);
      const command = JSON.parse(body || "{}");
      command.id ||= randomUUID();
      const clientId = command.clientId || "broadcast";
      const queue = pendingCommands.get(clientId) || [];
      queue.push(command);
      pendingCommands.set(clientId, queue);
      return json(res, 200, { ok: true, id: command.id });
    }

    if (req.method === "GET" && url.pathname === "/commands") {
      const clientId = url.searchParams.get("clientId") || "";
      let commands = [];
      const direct = pendingCommands.get(clientId);
      if (direct?.length) {
        commands = commands.concat(direct.splice(0));
        pendingCommands.set(clientId, direct);
      }
      const broadcast = pendingCommands.get("broadcast");
      if (broadcast?.length) {
        commands = commands.concat(broadcast.splice(0));
        pendingCommands.set("broadcast", broadcast);
      }
      return json(res, 200, commands);
    }

    if (req.method === "GET" && url.pathname === "/result") {
      const id = url.searchParams.get("id");
      return json(res, 200, id ? commandResults.get(id) || null : Object.fromEntries(commandResults));
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, events: events.length, pendingClients: pendingCommands.size });
    }

    return json(res, 404, { error: "not found" });
  } catch (error) {
    return json(res, 500, { error: error && error.stack ? error.stack : String(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`RunningHub bridge server listening on http://127.0.0.1:${PORT}`);
});
