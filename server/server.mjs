import http from "node:http";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

const PORT = 8765;
const RUNTIME_PATH = new URL("./bridge-runtime.js", import.meta.url);
const events = [];
const pendingCommands = new Map();
const commandResults = new Map();
const clients = new Map();

const canvasIdFromHref = (href) => {
  const match = String(href || "").match(/\/projects\/canvas\/([^/?#]+)/);
  return match ? match[1] : null;
};

const isCanvasClient = (client) => /runninghub\.cn\/projects\/canvas/.test(String(client?.href || ""));

const runtimeInfo = async () => {
  const [runtime, source] = await Promise.all([stat(RUNTIME_PATH), readFile(RUNTIME_PATH, "utf8")]);
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return { mtimeMs: runtime.mtimeMs, size: runtime.size, hash, version: `${runtime.mtimeMs}:${runtime.size}:${hash}`, source };
};

const selectClient = async (requestedClientId) => {
  const { source, ...runtime } = await runtimeInfo();
  const sorted = [...clients.values()]
    .filter(isCanvasClient)
    .sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0));
  const requested = requestedClientId ? clients.get(requestedClientId) : null;
  const fresh = sorted.filter((client) => !client.runtimeVersion || client.runtimeVersion === runtime.version);
  const selected = requested || fresh[0] || sorted[0] || null;
  const staleClients = sorted.filter((client) => client.runtimeVersion && client.runtimeVersion !== runtime.version);
  const selectedCanvasId = canvasIdFromHref(selected?.href);
  const sameCanvasClients = selectedCanvasId ? sorted.filter((client) => canvasIdFromHref(client.href) === selectedCanvasId) : [];
  const route = {
    selectedClientId: selected?.clientId,
    selectionReason: requested
      ? "requested clientId"
      : fresh[0]
        ? "latest active fresh RunningHub canvas tab"
        : sorted[0]
          ? "latest active canvas tab is stale"
          : "no RunningHub canvas client",
    canvasId: selectedCanvasId,
    href: selected?.href,
    runtimeFreshness: selected
      ? selected.runtimeVersion && selected.runtimeVersion !== runtime.version
        ? "stale"
        : "fresh"
      : "none",
    sameCanvasClients: sameCanvasClients.length,
    olderClientsIgnored: sorted
      .filter((client) => client.clientId !== selected?.clientId)
      .slice(0, 10)
      .map((client) => ({
        clientId: client.clientId,
        canvasId: canvasIdFromHref(client.href),
        reason: client.runtimeVersion && client.runtimeVersion !== runtime.version ? "stale runtime" : "older active client"
      })),
    staleClientIds: staleClients.map((client) => client.clientId),
    serverRuntimeVersion: runtime.version,
    selectedClientRuntimeVersion: selected?.runtimeVersion
  };
  return { runtime, sorted, selected, route };
};

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
      const runtime = await runtimeInfo();
      const source = `window.__RUNNINGHUB_CANVAS_BRIDGE_EXPECTED_VERSION__ = ${JSON.stringify(runtime.version)};\n${runtime.source}`;
      return javascript(res, 200, source);
    }

    if (req.method === "GET" && url.pathname === "/runtime-version") {
      const { source, ...runtime } = await runtimeInfo();
      return json(res, 200, runtime);
    }

    if (req.method === "POST" && url.pathname === "/events") {
      const body = await readBody(req);
      const event = JSON.parse(body || "{}");
      events.push(event);
      if (event.clientId) {
        clients.set(event.clientId, {
          clientId: event.clientId,
          href: event.href,
          title: event.title,
          runtimeVersion: event.runtimeVersion,
          runtimeCommands: event.runtimeCommands,
          canvasId: canvasIdFromHref(event.href),
          lastSeq: event.seq,
          lastSeenAt: Date.now()
        });
      }
      if (events.length > 1000) events.splice(0, events.length - 1000);
      if (event.kind === "command.result" && event.commandId) commandResults.set(event.commandId, event);
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/events") {
      const since = Number(url.searchParams.get("since") || "0");
      return json(res, 200, events.filter((event) => Number(event.seq || 0) > since));
    }

    if (req.method === "GET" && url.pathname === "/clients") {
      const { selected, route, sorted } = await selectClient();
      return json(
        res,
        200,
        sorted.map((client) => ({
          ...client,
          selected: client.clientId === selected?.clientId,
          selectionReason: client.clientId === selected?.clientId ? route.selectionReason : undefined,
          runtimeFreshness:
            client.runtimeVersion && client.runtimeVersion !== route.serverRuntimeVersion ? "stale" : "fresh",
          sameCanvasClients: route.canvasId && canvasIdFromHref(client.href) === route.canvasId ? route.sameCanvasClients : undefined
        }))
      );
    }

    if (req.method === "GET" && url.pathname === "/diagnose-extension") {
      const { route, sorted } = await selectClient();
      const recentEvents = events.slice(-20).map(({ kind, clientId, ts, href, runtimeVersion, error }) => ({
        kind,
        clientId,
        ts,
        href,
        runtimeVersion,
        error
      }));
      return json(res, 200, {
        ok: Boolean(route.selectedClientId && route.runtimeFreshness === "fresh"),
        bridgeUrl: `http://127.0.0.1:${PORT}`,
        runtimeUrl: `http://127.0.0.1:${PORT}/bridge-runtime.js`,
        expectedExtensionMatches: ["https://rhtv.runninghub.cn/*"],
        connectedCanvasClients: sorted.length,
        route,
        recentEvents,
        nextActions: route.selectedClientId
          ? route.runtimeFreshness === "fresh"
            ? []
            : ["Refresh the RunningHub canvas tab so the extension reloads the latest bridge runtime."]
          : [
              "Open or refresh a logged-in RunningHub canvas page.",
              "Verify the unpacked extension is enabled in the same Chrome profile as the RunningHub tab.",
              "If Chrome asks whether rhtv.runninghub.cn can access local devices or services, allow it so the page can reach 127.0.0.1.",
              "Open the extension details and confirm it matches https://rhtv.runninghub.cn/*."
            ]
      });
    }

    if (req.method === "POST" && url.pathname === "/command") {
      const body = await readBody(req);
      const command = JSON.parse(body || "{}");
      command.id ||= randomUUID();
      const { route, selected } = await selectClient(command.clientId);
      const clientId = command.clientId || (command.broadcast ? "broadcast" : route.selectedClientId);
      const selectedClient = clientId === "broadcast" ? null : selected;
      if (clientId !== "broadcast" && !selectedClient) {
        return json(res, 409, {
          ok: false,
          errorCode: "NO_PAGE_CLIENT",
          error: "No live RunningHub canvas page client is connected.",
          route,
          nextActions: [
            "Open or refresh a logged-in RunningHub canvas page with the unpacked extension enabled.",
            "Run `npm run bridge -- diagnose-extension` for setup diagnostics."
          ]
        });
      }
      if (clientId !== "broadcast" && selectedClient.runtimeVersion && selectedClient.runtimeVersion !== route.serverRuntimeVersion) {
        return json(res, 409, {
          ok: false,
          errorCode: "STALE_RUNTIME",
          error: "stale runtime client",
          clientId,
          clientRuntimeVersion: selectedClient.runtimeVersion,
          serverRuntimeVersion: route.serverRuntimeVersion,
          route,
          nextActions: ["Refresh the RunningHub canvas tab so it picks up the latest bridge runtime."]
        });
      }
      const queue = pendingCommands.get(clientId) || [];
      queue.push(command);
      pendingCommands.set(clientId, queue);
      return json(res, 200, { ok: true, id: command.id, clientId, route });
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
