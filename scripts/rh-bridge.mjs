#!/usr/bin/env node
import { randomUUID } from "node:crypto";

const DEFAULT_BRIDGE = "http://127.0.0.1:8765";
const bridge = process.env.RH_BRIDGE_URL || DEFAULT_BRIDGE;

const usage = `Usage:
  node scripts/rh-bridge.mjs health
  node scripts/rh-bridge.mjs events [--since <seq>]
  node scripts/rh-bridge.mjs snapshot [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs export-workflow [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs yjs-snapshot [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs create-text-workflow [--client <clientId>] [--timeout <ms>] [--config-json <json>]
  node scripts/rh-bridge.mjs create-text-node [--client <clientId>] [--timeout <ms>] [--config-json <json>]
  node scripts/rh-bridge.mjs connect-nodes <sourceId> <targetId> [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs update-node-text <nodeId> <text> [--client <clientId>] [--timeout <ms>] [--title <title>]
  node scripts/rh-bridge.mjs move-node <nodeId> <x> <y> [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs delete-elements <id...> [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs get-canvas-detail <canvasId> [--timeout <ms>] [--body-json <json>]
  node scripts/rh-bridge.mjs workflow-list <canvasId> [--timeout <ms>] [--body-json <json>]
  node scripts/rh-bridge.mjs api-post <endpoint> [--body-json <json>] [--timeout <ms>]
  node scripts/rh-bridge.mjs result <commandId>

Environment:
  RH_BRIDGE_URL  Bridge base URL. Defaults to ${DEFAULT_BRIDGE}
`;

const args = process.argv.slice(2);
const commandName = args.shift();

const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`Missing value for ${name}`);
  args.splice(index, 2);
  return value;
};

const bodyOption = (fallback) => {
  const raw = option("--body-json");
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`Invalid --body-json: ${error.message}`);
  }
};

const configOption = (fallback = {}) => {
  const raw = option("--config-json");
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`Invalid --config-json: ${error.message}`);
  }
};

const request = async (path, init) => {
  const response = await fetch(new URL(path, bridge), init);
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    value = text;
  }
  if (!response.ok) fail(JSON.stringify(value, null, 2));
  return value;
};

const print = (value) => {
  console.log(JSON.stringify(value, null, 2));
};

const waitForResult = async (id, timeoutMs) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await request(`/result?id=${encodeURIComponent(id)}`);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`Timed out waiting for command result: ${id}`);
};

const enqueue = async (command, timeoutMs) => {
  command.id ||= randomUUID();
  const accepted = await request("/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  if (!timeoutMs) return accepted;
  const event = await waitForResult(accepted.id, timeoutMs);
  return event.result ?? event;
};

if (!commandName || commandName === "-h" || commandName === "--help") {
  console.log(usage);
  process.exit(commandName ? 0 : 1);
}

const timeoutMs = Number(option("--timeout", "15000"));
const clientId = option("--client");
const title = option("--title");
const baseCommand = clientId ? { clientId } : {};

if (commandName === "health") {
  print(await request("/health"));
} else if (commandName === "events") {
  const since = option("--since", "0");
  print(await request(`/events?since=${encodeURIComponent(since)}`));
} else if (commandName === "snapshot") {
  print(await enqueue({ ...baseCommand, type: "graph.snapshot" }, timeoutMs));
} else if (commandName === "export-workflow") {
  print(await enqueue({ ...baseCommand, type: "canvas.exportWorkflow" }, timeoutMs));
} else if (commandName === "yjs-snapshot") {
  print(await enqueue({ ...baseCommand, type: "canvas.yjsSnapshot" }, timeoutMs));
} else if (commandName === "create-text-workflow") {
  const config = configOption();
  print(await enqueue({ ...baseCommand, type: "canvas.createTextWorkflow", config }, timeoutMs));
} else if (commandName === "create-text-node") {
  const config = configOption();
  print(await enqueue({ ...baseCommand, type: "canvas.createTextNode", config }, timeoutMs));
} else if (commandName === "connect-nodes") {
  const source = args.shift();
  const target = args.shift();
  if (!source) fail("Missing sourceId");
  if (!target) fail("Missing targetId");
  print(await enqueue({ ...baseCommand, type: "canvas.connectNodes", source, target }, timeoutMs));
} else if (commandName === "update-node-text") {
  const nodeId = args.shift();
  const text = args.shift();
  if (!nodeId) fail("Missing nodeId");
  if (text === undefined) fail("Missing text");
  print(await enqueue({ ...baseCommand, type: "canvas.updateNodeText", nodeId, text, title }, timeoutMs));
} else if (commandName === "move-node") {
  const nodeId = args.shift();
  const x = args.shift();
  const y = args.shift();
  if (!nodeId) fail("Missing nodeId");
  if (x === undefined) fail("Missing x");
  if (y === undefined) fail("Missing y");
  print(await enqueue({ ...baseCommand, type: "canvas.updateNodePosition", nodeId, x, y }, timeoutMs));
} else if (commandName === "delete-elements") {
  const ids = args.splice(0);
  if (!ids.length) fail("Missing id");
  print(await enqueue({ ...baseCommand, type: "canvas.deleteElements", ids }, timeoutMs));
} else if (commandName === "get-canvas-detail") {
  const canvasId = args.shift();
  if (!canvasId) fail("Missing canvasId");
  const body = bodyOption({ id: canvasId });
  print(await enqueue({ ...baseCommand, type: "canvas.getDetail", canvasId, body }, timeoutMs));
} else if (commandName === "workflow-list") {
  const canvasId = args.shift();
  if (!canvasId) fail("Missing canvasId");
  const body = bodyOption({ canvasId });
  print(await enqueue({ ...baseCommand, type: "canvas.workflowList", canvasId, body }, timeoutMs));
} else if (commandName === "api-post") {
  const endpoint = args.shift();
  if (!endpoint) fail("Missing endpoint");
  const body = bodyOption({});
  print(await enqueue({ ...baseCommand, type: "api.post", endpoint, body }, timeoutMs));
} else if (commandName === "result") {
  const id = args.shift();
  if (!id) fail("Missing commandId");
  print(await request(`/result?id=${encodeURIComponent(id)}`));
} else {
  fail(`Unknown command: ${commandName}\n\n${usage}`);
}
