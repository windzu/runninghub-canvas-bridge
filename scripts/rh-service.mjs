#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform, userInfo } from "node:os";

const action = process.argv[2] || "status";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const label = "cn.runninghub.canvas-bridge";
const plistPath = resolve(homedir(), "Library/LaunchAgents", `${label}.plist`);
const logDir = resolve(homedir(), "Library/Logs/runninghub-canvas-bridge");
const outLog = resolve(logDir, "bridge.out.log");
const errLog = resolve(logDir, "bridge.err.log");
const serverPath = resolve(repoRoot, "server/server.mjs");
const nodePath = process.execPath;
const guiTarget = `gui/${userInfo().uid}`;

const print = (value) => console.log(JSON.stringify(value, null, 2));

const fail = (message, extra = {}) => {
  print({ ok: false, error: message, ...extra });
  process.exit(1);
};

const ensureMac = () => {
  if (platform() !== "darwin") {
    fail("Persistent service helper currently supports macOS LaunchAgent only.", {
      nextActions: ["Run `npm run start` manually on non-macOS platforms."]
    });
  }
};

const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim()
  };
};

const plist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${serverPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${outLog}</string>
  <key>StandardErrorPath</key>
  <string>${errLog}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
</dict>
</plist>
`;

const serviceStatus = () => {
  ensureMac();
  const list = run("launchctl", ["list", label]);
  const health = run(nodePath, [resolve(repoRoot, "scripts/rh-bridge.mjs"), "health"], { cwd: repoRoot });
  return {
    ok: list.ok && health.ok,
    installed: existsSync(plistPath),
    loaded: list.ok,
    label,
    plistPath,
    logs: { stdout: outLog, stderr: errLog },
    launchctl: list.ok ? list.stdout : list.stderr,
    bridgeHealth: health.ok ? JSON.parse(health.stdout || "{}") : null,
    bridgeHealthError: health.ok ? null : health.stderr || health.stdout || null
  };
};

const install = () => {
  ensureMac();
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(plistPath, plist(), "utf8");
  const bootstrap = run("launchctl", ["bootstrap", guiTarget, plistPath]);
  if (!bootstrap.ok && !/already bootstrapped|service already loaded/i.test(bootstrap.stderr)) {
    fail("Failed to bootstrap LaunchAgent.", { plistPath, launchctl: bootstrap.stderr });
  }
  run("launchctl", ["kickstart", "-k", `${guiTarget}/${label}`]);
  print({ ok: true, action: "install", ...serviceStatus() });
};

const start = () => {
  ensureMac();
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  if (!existsSync(plistPath)) writeFileSync(plistPath, plist(), "utf8");
  const bootstrap = run("launchctl", ["bootstrap", guiTarget, plistPath]);
  if (!bootstrap.ok && !/already bootstrapped|service already loaded/i.test(bootstrap.stderr)) {
    fail("Failed to bootstrap LaunchAgent.", { plistPath, launchctl: bootstrap.stderr });
  }
  const kickstart = run("launchctl", ["kickstart", "-k", `${guiTarget}/${label}`]);
  if (!kickstart.ok) fail("Failed to start LaunchAgent.", { launchctl: kickstart.stderr });
  print({ ok: true, action: "start", ...serviceStatus() });
};

const stop = () => {
  ensureMac();
  if (existsSync(plistPath)) run("launchctl", ["bootout", guiTarget, plistPath]);
};

const uninstall = () => {
  ensureMac();
  stop();
  if (existsSync(plistPath)) rmSync(plistPath);
  print({ ok: true, action: "uninstall", installed: false, label, plistPath });
};

if (action === "install") install();
else if (action === "start") start();
else if (action === "status") print(serviceStatus());
else if (action === "restart") {
  stop();
  start();
} else if (action === "uninstall") uninstall();
else if (action === "plist") {
  print({ ok: true, plistPath, plist: existsSync(plistPath) ? readFileSync(plistPath, "utf8") : plist() });
} else {
  fail(`Unknown service action: ${action}`, {
    usage: ["install", "start", "status", "restart", "uninstall", "plist"].map((name) => `node scripts/rh-service.mjs ${name}`)
  });
}
