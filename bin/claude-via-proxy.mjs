#!/usr/bin/env node

import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "../proxy/server.mjs");

const args = process.argv.slice(2);
let proxyPort = 9801;
let proxyUpstream = undefined;
const claudeArgs = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--proxy-port" && args[i + 1]) {
    proxyPort = parseInt(args[++i], 10);
  } else if (args[i] === "--proxy-upstream" && args[i + 1]) {
    proxyUpstream = args[++i];
  } else {
    claudeArgs.push(args[i]);
  }
}

const proxyEnv = { ...process.env, CACHE_FIX_PROXY_PORT: String(proxyPort) };
if (proxyUpstream) proxyEnv.CACHE_FIX_PROXY_UPSTREAM = proxyUpstream;

const proxyProc = fork(SERVER_PATH, [], {
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: proxyEnv,
});

let claudeProc = null;
let exiting = false;

function cleanup(code) {
  if (exiting) return;
  exiting = true;
  if (claudeProc && !claudeProc.killed) claudeProc.kill("SIGTERM");
  if (proxyProc && !proxyProc.killed) proxyProc.kill("SIGTERM");
  setTimeout(() => process.exit(code), 3000);
}

proxyProc.on("exit", (code) => {
  if (!exiting) {
    process.stderr.write(`proxy exited unexpectedly (code ${code})\n`);
    cleanup(1);
  }
});

proxyProc.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

function waitForHealth(port, maxAttempts = 30, interval = 200) {
  let attempts = 0;
  return new Promise((resolve, reject) => {
    function check() {
      attempts++;
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        if (res.statusCode === 200) {
          res.resume();
          resolve();
        } else {
          retry();
        }
      });
      req.on("error", retry);
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    }
    function retry() {
      if (attempts >= maxAttempts) {
        reject(new Error(`Proxy failed to become ready after ${maxAttempts} attempts`));
        return;
      }
      setTimeout(check, interval);
    }
    check();
  });
}

try {
  await waitForHealth(proxyPort);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  cleanup(1);
  process.exit(1);
}

const claudeEnv = {
  ...process.env,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxyPort}`,
};

claudeProc = spawn("claude", claudeArgs, {
  stdio: "inherit",
  env: claudeEnv,
});

claudeProc.on("error", (err) => {
  if (err.code === "ENOENT") {
    process.stderr.write("Error: 'claude' command not found. Is Claude Code installed?\n");
  } else {
    process.stderr.write(`Failed to start claude: ${err.message}\n`);
  }
  cleanup(1);
});

claudeProc.on("exit", (code) => {
  cleanup(code ?? 0);
  process.exit(code ?? 0);
});

process.on("SIGINT", () => cleanup(130));
process.on("SIGTERM", () => cleanup(143));
