#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const bridgeScript = resolve(repoRoot, "scripts/rh-bridge.mjs");
const serverScript = resolve(repoRoot, "server/server.mjs");
const extensionDir = resolve(repoRoot, "extension");
const configDir = resolve(homedir(), ".runninghub-canvas-bridge");
const reportPath = resolve(configDir, "diagnostic-report.json");
const pidPath = resolve(configDir, "bridge.pid");
const bridgeUrl = process.env.RH_BRIDGE_URL || "http://127.0.0.1:8765";
const issueUrl = packageJson.bugs?.url || "https://github.com/windzu/runninghub-canvas-bridge/issues";

const command = process.argv[2] || "help";
const args = process.argv.slice(3);
const verbose = args.includes("--verbose");

const print = (value) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

const runNode = (script, scriptArgs, options = {}) => {
  const result = spawnSync(process.execPath, [script, ...scriptArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    ...options
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim()
  };
};

const parseJson = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text || null;
  }
};

const bridgeCommand = (name, commandArgs = []) => runNode(bridgeScript, [name, ...commandArgs]);

const readPid = () => {
  try {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const isProcessAlive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const compactClient = (client) => ({
  clientId: client?.clientId,
  selected: client?.selected,
  canvasId: client?.canvasId,
  runtimeFreshness: client?.runtimeFreshness,
  href: client?.href,
  title: client?.title,
  lastSeenAt: client?.lastSeenAt
});

const compactDiagnostics = (value) => {
  if (verbose || !value || typeof value !== "object") return value;
  const clone = JSON.parse(JSON.stringify(value));
  const compactRoute = (route) => {
    if (!route || typeof route !== "object") return;
    route.olderClientsIgnoredCount = Array.isArray(route.olderClientsIgnored) ? route.olderClientsIgnored.length : 0;
    route.staleClientCount = Array.isArray(route.staleClientIds) ? route.staleClientIds.length : 0;
    delete route.olderClientsIgnored;
    delete route.staleClientIds;
  };
  compactRoute(clone.route);
  compactRoute(clone.extensionDiagnostics?.route);
  if (Array.isArray(clone.clients)) {
    const selected = clone.clients.find((client) => client?.selected) || clone.clients[0];
    clone.clientSummary = {
      connectedClients: clone.clients.length,
      selectedClient: compactClient(selected),
      staleClientCount: clone.clients.filter((client) => client?.runtimeFreshness === "stale").length
    };
    delete clone.clients;
  }
  const pageClient = clone.preflight?.checks?.pageClient;
  if (pageClient?.olderClientsIgnored) {
    pageClient.olderClientsIgnoredCount = pageClient.olderClientsIgnored.length;
    delete pageClient.olderClientsIgnored;
  }
  const runtimeFreshness = clone.preflight?.checks?.runtimeFreshness;
  if (runtimeFreshness?.staleClientIds) {
    runtimeFreshness.staleClientCount = runtimeFreshness.staleClientIds.length;
    delete runtimeFreshness.staleClientIds;
  }
  return clone;
};

const redacted = (value) => {
  const text = JSON.stringify(value, (key, item) => (/authorization|token|cookie/i.test(key) ? "[REDACTED]" : item), 2);
  return JSON.parse(
    text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, "$1[REDACTED]").replace(/([?&][^=]*(?:authorization|token|cookie)[^=]*=)[^"&\s]+/gi, "$1[REDACTED]")
  );
};

const help = () => `RunningHub Canvas Bridge ${packageJson.version}

Usage:
  runninghub-canvas-bridge setup
  runninghub-canvas-bridge start [--daemon]
  runninghub-canvas-bridge stop
  runninghub-canvas-bridge restart
  runninghub-canvas-bridge doctor
  runninghub-canvas-bridge status
  runninghub-canvas-bridge report [--write]
  runninghub-canvas-bridge extension
  runninghub-canvas-bridge <bridge-command> [...args]

Common bridge commands:
  agent-manifest, preflight, diagnose-extension, canvas-summary, clients, events

Release contract:
  Agents should use this CLI, the local HTTP API, or MCP wrappers when available.
  Do not patch installed package internals to recover from product errors; run doctor/report.
  Report product issues at: ${issueUrl}
`;

const setup = () => {
  mkdirSync(configDir, { recursive: true });
  print({
    ok: true,
    product: packageJson.name,
    version: packageJson.version,
    bridgeUrl,
    configDir,
    issueUrl,
    extension: {
      unpackedPath: extensionDir,
      installSteps: [
        "Open chrome://extensions/ in the Chrome profile logged in to RunningHub.",
        "Enable Developer mode.",
        "Click Load unpacked and select the extension unpackedPath.",
        "Open or refresh https://rhtv.runninghub.cn/projects/canvas/<canvas_id>.",
        "Allow Chrome local-network access if prompted so the page can reach 127.0.0.1."
      ]
    },
    nextCommands: ["runninghub-canvas-bridge start --daemon", "runninghub-canvas-bridge doctor"],
    feedback: {
      whenBlocked: "Run `runninghub-canvas-bridge report --write` and attach the redacted report to a GitHub Issue.",
      issueUrl
    }
  });
};

const extensionInfo = () => {
  const manifestPath = resolve(extensionDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const files = ["manifest.json", "bridge-main.js"];
  const hash = createHash("sha256");
  for (const file of files) hash.update(readFileSync(resolve(extensionDir, file)));
  print(compactDiagnostics({
    ok: true,
    name: manifest.name,
    version: manifest.version,
    protocolVersion: manifest.runninghub_canvas_bridge_protocol || "1",
    unpackedPath: extensionDir,
    contentScriptMatches: manifest.content_scripts?.flatMap((item) => item.matches || []) || [],
    hostPermissions: manifest.host_permissions || [],
    sha256: hash.digest("hex"),
    installSteps: [
      "Download the extension zip from the matching GitHub Release, or use unpackedPath from the npm package.",
      "Open chrome://extensions/.",
      "Enable Developer mode.",
      "Load unpacked extension directory, then refresh the RunningHub canvas tab."
    ]
  }));
};

const start = () => {
  if (args.includes("--daemon")) {
    mkdirSync(configDir, { recursive: true });
    const existingPid = readPid();
    if (isProcessAlive(existingPid)) {
      print({ ok: true, alreadyRunning: true, pid: existingPid, bridgeUrl, nextCommands: ["runninghub-canvas-bridge status", "runninghub-canvas-bridge doctor"] });
      return;
    }
    const health = bridgeCommand("health");
    if (health.ok) {
      print({ ok: true, alreadyRunning: true, pid: null, bridgeUrl, bridgeHealth: parseJson(health.stdout), note: "Bridge is already reachable but was not started by this CLI daemon pid file." });
      return;
    }
    const child = spawn(process.execPath, [serverScript], {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" }
    });
    child.unref();
    writeFileSync(pidPath, `${child.pid}\n`, "utf8");
    print({ ok: true, daemon: true, pid: child.pid, pidPath, bridgeUrl, nextCommands: ["runninghub-canvas-bridge doctor"] });
    return;
  }
  const child = spawn(process.execPath, [serverScript], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" }
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code || 0);
  });
};

const stop = ({ quiet = false } = {}) => {
  const pid = readPid();
  if (!pid) {
    const value = { ok: true, stopped: true, alreadyStopped: true, pidPath };
    if (!quiet) print(value);
    return value;
  }
  if (isProcessAlive(pid)) process.kill(pid, "SIGTERM");
  if (existsSync(pidPath)) rmSync(pidPath);
  const value = { ok: true, stopped: true, pid };
  if (!quiet) print(value);
  return value;
};

const status = () => {
  const health = bridgeCommand("health");
  const clients = health.ok ? bridgeCommand("clients") : null;
  print(compactDiagnostics({
    ok: health.ok,
    product: packageJson.name,
    version: packageJson.version,
    bridgeUrl,
    issueUrl,
    daemon: { pid: readPid(), running: isProcessAlive(readPid()), pidPath },
    bridgeHealth: health.ok ? parseJson(health.stdout) : null,
    clients: clients?.ok ? parseJson(clients.stdout) : [],
    error: health.ok ? null : parseJson(health.stdout) || health.stderr || "Bridge server is offline.",
    nextActions: health.ok ? [] : ["Start the bridge with `runninghub-canvas-bridge start --daemon`."]
  }));
};

const doctor = () => {
  const health = bridgeCommand("health");
  const preflight = bridgeCommand("preflight", args);
  const diagnose = bridgeCommand("diagnose-extension");
  const value = {
    ok: preflight.ok && Boolean(parseJson(preflight.stdout)?.ok),
    product: packageJson.name,
    version: packageJson.version,
    bridgeUrl,
    issueUrl,
    health: health.ok ? parseJson(health.stdout) : { ok: false, error: parseJson(health.stdout) || health.stderr || "Bridge server is offline." },
    preflight: preflight.ok ? parseJson(preflight.stdout) : parseJson(preflight.stdout) || preflight.stderr,
    extensionDiagnostics: diagnose.ok ? parseJson(diagnose.stdout) : parseJson(diagnose.stdout) || diagnose.stderr,
    nextActions: preflight.ok ? parseJson(preflight.stdout)?.nextActions || [] : ["Start the bridge with `runninghub-canvas-bridge start --daemon`, then rerun doctor."],
    feedback: {
      whenBlocked: "Run `runninghub-canvas-bridge report --write` and attach the redacted report to a GitHub Issue.",
      issueUrl
    }
  };
  print(compactDiagnostics(redacted(value)));
  process.exit(value.ok ? 0 : 1);
};

const report = () => {
  const write = args.includes("--write");
  const commands = {
    health: bridgeCommand("health"),
    preflight: bridgeCommand("preflight"),
    diagnoseExtension: bridgeCommand("diagnose-extension"),
    clients: bridgeCommand("clients")
  };
  const value = redacted({
    ok: commands.health.ok,
    generatedAt: new Date().toISOString(),
    product: packageJson.name,
    version: packageJson.version,
    bridgeUrl,
    issueUrl,
    platform: process.platform,
    nodeVersion: process.version,
    extensionPathExists: existsSync(extensionDir),
    commands: Object.fromEntries(
      Object.entries(commands).map(([key, item]) => [
        key,
        {
          ok: item.ok,
          status: item.status,
          stdout: parseJson(item.stdout),
          stderr: item.stderr || undefined
        }
      ])
    ),
    sharingPolicy: "Safe to share after review. Auth headers, cookies, and token-like fields are redacted by the CLI.",
    feedback: {
      issueUrl,
      requestedIssueContents: [
        "Attach this diagnostic report.",
        "Describe the command that failed.",
        "Describe what the Agent expected and what happened instead.",
        "Do not include cookies, tokens, authorization headers, or private RunningHub payloads."
      ]
    }
  });
  if (write) {
    mkdirSync(configDir, { recursive: true });
    const compactValue = compactDiagnostics(value);
    writeFileSync(reportPath, `${JSON.stringify(compactValue, null, 2)}\n`, "utf8");
    print({ ok: true, reportPath, report: compactValue });
  } else print(compactDiagnostics(value));
};

if (command === "help" || command === "-h" || command === "--help") print(help());
else if (command === "version" || command === "--version" || command === "-v") print(packageJson.version);
else if (command === "setup" || command === "init") setup();
else if (command === "start") start();
else if (command === "stop") stop();
else if (command === "restart") {
  stop({ quiet: true });
  args.push("--daemon");
  start();
}
else if (command === "doctor" || command === "diagnose") doctor();
else if (command === "status") status();
else if (command === "report") report();
else if (command === "extension") extensionInfo();
else {
  const passthrough = runNode(bridgeScript, [command, ...args], { stdio: "inherit" });
  process.exit(passthrough.status ?? (passthrough.ok ? 0 : 1));
}
