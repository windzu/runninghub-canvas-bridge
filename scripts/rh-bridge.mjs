#!/usr/bin/env node
import { randomUUID } from "node:crypto";

const DEFAULT_BRIDGE = "http://127.0.0.1:8765";
const bridge = process.env.RH_BRIDGE_URL || DEFAULT_BRIDGE;

const usage = `Usage:
  node scripts/rh-bridge.mjs health
  node scripts/rh-bridge.mjs clients
  node scripts/rh-bridge.mjs events [--since <seq>]
  node scripts/rh-bridge.mjs snapshot [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs export-workflow [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs yjs-snapshot [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs rollback-list [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs rollback [rollbackId] [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs capabilities [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs find-elements [--client <clientId>] [--timeout <ms>] [--query-json <json>]
  node scripts/rh-bridge.mjs get-element <id> [--client <clientId>] [--timeout <ms>]
  node scripts/rh-bridge.mjs connections <nodeId> [--client <clientId>] [--timeout <ms>] [--direction <both|upstream|downstream>] [--depth <n>]
  node scripts/rh-bridge.mjs create-text-workflow [--client <clientId>] [--timeout <ms>] [--config-json <json>] [--dry-run]
  node scripts/rh-bridge.mjs create-text-node [--client <clientId>] [--timeout <ms>] [--config-json <json>] [--dry-run]
  node scripts/rh-bridge.mjs create-node [--client <clientId>] [--timeout <ms>] [--config-json <json>] [--dry-run]
  node scripts/rh-bridge.mjs connect-nodes <sourceId> <targetId> [--client <clientId>] [--timeout <ms>] [--dry-run]
  node scripts/rh-bridge.mjs update-node <nodeId> [--client <clientId>] [--timeout <ms>] [--patch-json <json>] [--data-json <json>] [--title <title>] [--dry-run]
  node scripts/rh-bridge.mjs update-node-text <nodeId> <text> [--client <clientId>] [--timeout <ms>] [--title <title>] [--dry-run]
  node scripts/rh-bridge.mjs move-node <nodeId> <x> <y> [--client <clientId>] [--timeout <ms>] [--dry-run]
  node scripts/rh-bridge.mjs move-nodes <id...> [--client <clientId>] [--timeout <ms>] [--dx <n>] [--dy <n>] [--positions-json <json>] [--dry-run]
  node scripts/rh-bridge.mjs delete-elements <id...> [--client <clientId>] [--timeout <ms>] [--dry-run]
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

const flag = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
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

const jsonOption = (name, fallback = {}) => {
  const raw = option(name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`Invalid ${name}: ${error.message}`);
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
const direction = option("--direction", "both");
const depth = option("--depth", "1");
const dx = option("--dx", "0");
const dy = option("--dy", "0");
const dryRun = flag("--dry-run");
const baseCommand = clientId ? { clientId } : {};

if (commandName === "health") {
  print(await request("/health"));
} else if (commandName === "clients") {
  print(await request("/clients"));
} else if (commandName === "events") {
  const since = option("--since", "0");
  print(await request(`/events?since=${encodeURIComponent(since)}`));
} else if (commandName === "snapshot") {
  print(await enqueue({ ...baseCommand, type: "graph.snapshot" }, timeoutMs));
} else if (commandName === "export-workflow") {
  print(await enqueue({ ...baseCommand, type: "canvas.exportWorkflow" }, timeoutMs));
} else if (commandName === "yjs-snapshot") {
  print(await enqueue({ ...baseCommand, type: "canvas.yjsSnapshot" }, timeoutMs));
} else if (commandName === "rollback-list") {
  print(await enqueue({ ...baseCommand, type: "canvas.rollbackList" }, timeoutMs));
} else if (commandName === "rollback") {
  const rollbackId = args.shift();
  print(await enqueue({ ...baseCommand, type: "canvas.rollback", rollbackId }, timeoutMs));
} else if (commandName === "capabilities") {
  print(await enqueue({ ...baseCommand, type: "canvas.capabilities" }, timeoutMs));
} else if (commandName === "find-elements") {
  const query = jsonOption("--query-json");
  print(await enqueue({ ...baseCommand, type: "canvas.findElements", query }, timeoutMs));
} else if (commandName === "get-element") {
  const id = args.shift();
  if (!id) fail("Missing id");
  print(await enqueue({ ...baseCommand, type: "canvas.getElement", id }, timeoutMs));
} else if (commandName === "connections") {
  const nodeId = args.shift();
  if (!nodeId) fail("Missing nodeId");
  print(await enqueue({ ...baseCommand, type: "canvas.getConnections", nodeId, direction, depth }, timeoutMs));
} else if (commandName === "create-text-workflow") {
  const config = configOption();
  print(await enqueue({ ...baseCommand, type: "canvas.createTextWorkflow", config, dryRun }, timeoutMs));
} else if (commandName === "create-text-node") {
  const config = configOption();
  print(await enqueue({ ...baseCommand, type: "canvas.createTextNode", config, dryRun }, timeoutMs));
} else if (commandName === "create-node") {
  const config = configOption();
  print(await enqueue({ ...baseCommand, type: "canvas.createNode", config, dryRun }, timeoutMs));
} else if (commandName === "connect-nodes") {
  const source = args.shift();
  const target = args.shift();
  if (!source) fail("Missing sourceId");
  if (!target) fail("Missing targetId");
  print(await enqueue({ ...baseCommand, type: "canvas.connectNodes", source, target, dryRun }, timeoutMs));
} else if (commandName === "update-node") {
  const nodeId = args.shift();
  if (!nodeId) fail("Missing nodeId");
  const patch = jsonOption("--patch-json");
  const data = jsonOption("--data-json", undefined);
  print(await enqueue({ ...baseCommand, type: "canvas.updateNode", nodeId, patch, data, title, dryRun }, timeoutMs));
} else if (commandName === "update-node-text") {
  const nodeId = args.shift();
  const text = args.shift();
  if (!nodeId) fail("Missing nodeId");
  if (text === undefined) fail("Missing text");
  print(await enqueue({ ...baseCommand, type: "canvas.updateNodeText", nodeId, text, title, dryRun }, timeoutMs));
} else if (commandName === "move-node") {
  const nodeId = args.shift();
  const x = args.shift();
  const y = args.shift();
  if (!nodeId) fail("Missing nodeId");
  if (x === undefined) fail("Missing x");
  if (y === undefined) fail("Missing y");
  print(await enqueue({ ...baseCommand, type: "canvas.updateNodePosition", nodeId, x, y, dryRun }, timeoutMs));
} else if (commandName === "move-nodes") {
  const positions = jsonOption("--positions-json", {});
  const ids = args.splice(0);
  if (!ids.length) fail("Missing id");
  print(await enqueue({ ...baseCommand, type: "canvas.moveNodes", ids, dx, dy, positions, dryRun }, timeoutMs));
} else if (commandName === "delete-elements") {
  const ids = args.splice(0);
  if (!ids.length) fail("Missing id");
  print(await enqueue({ ...baseCommand, type: "canvas.deleteElements", ids, dryRun }, timeoutMs));
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
