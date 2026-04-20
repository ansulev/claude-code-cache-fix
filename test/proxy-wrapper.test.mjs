import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER_PATH = resolve(__dirname, "../bin/claude-via-proxy.mjs");
const SERVER_PATH = resolve(__dirname, "../proxy/server.mjs");

describe("proxy server lifecycle", () => {
  it("starts and responds to health check", async () => {
    const proxyProc = fork(SERVER_PATH, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, CACHE_FIX_PROXY_PORT: "0", CACHE_FIX_PROXY_BIND: "127.0.0.1" },
    });

    let port;
    await new Promise((resolve, reject) => {
      let output = "";
      proxyProc.stdout.on("data", (chunk) => {
        output += chunk.toString();
        const match = output.match(/:(\d+)/);
        if (match) { port = parseInt(match[1], 10); resolve(); }
      });
      proxyProc.on("error", reject);
      proxyProc.on("exit", (code) => {
        if (!port) reject(new Error(`Proxy exited (code ${code}) before ready`));
      });
      setTimeout(() => reject(new Error("Proxy startup timeout")), 10000);
    });

    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, resolve).on("error", reject);
    });
    assert.equal(res.statusCode, 200);

    proxyProc.kill("SIGTERM");
    await new Promise((resolve) => proxyProc.on("exit", resolve));
  });

  it("shuts down cleanly on SIGTERM", async () => {
    const proxyProc = fork(SERVER_PATH, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, CACHE_FIX_PROXY_PORT: "0", CACHE_FIX_PROXY_BIND: "127.0.0.1" },
    });

    await new Promise((resolve) => {
      proxyProc.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("listening")) resolve();
      });
      setTimeout(resolve, 2000);
    });

    proxyProc.kill("SIGTERM");
    const code = await new Promise((resolve) => proxyProc.on("exit", (c) => resolve(c)));
    assert.equal(code, 0);
  });
});

describe("launch wrapper (claude-via-proxy)", () => {
  it("exits with error when claude command is not found", async () => {
    const wrapperProc = fork(WRAPPER_PATH, ["--proxy-port", "0"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        CACHE_FIX_PROXY_BIND: "127.0.0.1",
        CACHE_FIX_CLAUDE_CMD: "/nonexistent/path/to/claude",
      },
    });

    let stderr = "";
    wrapperProc.stderr.on("data", (c) => { stderr += c.toString(); });

    const code = await new Promise((resolve) => {
      wrapperProc.on("exit", (c) => resolve(c));
      setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
    });

    assert.ok(code !== 0, `Wrapper should exit non-zero. stderr: ${stderr}`);
  });

  it("sets ANTHROPIC_BASE_URL and forwards to child process", async () => {
    const script = resolve(__dirname, ".fake-claude-env.mjs");
    writeFileSync(script, 'process.stdout.write("BASE_URL=" + process.env.ANTHROPIC_BASE_URL + "\\n");\nprocess.exit(0);\n');

    try {
      const wrapperProc = fork(WRAPPER_PATH, ["--proxy-port", "0"], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: {
          ...process.env,
          CACHE_FIX_PROXY_BIND: "127.0.0.1",
          CACHE_FIX_CLAUDE_CMD: `${process.execPath} ${script}`,
        },
      });

      let stdout = "";
      wrapperProc.stdout.on("data", (c) => { stdout += c.toString(); });

      const code = await new Promise((resolve) => {
        wrapperProc.on("exit", (c) => resolve(c));
        setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
      });

      assert.ok(stdout.includes("BASE_URL=http://127.0.0.1:"), `Expected BASE_URL in output, got: ${stdout}`);
      assert.equal(code, 0);
    } finally {
      try { unlinkSync(script); } catch {}
    }
  });

  it("propagates claude exit code", async () => {
    const script = resolve(__dirname, ".fake-claude-exit.mjs");
    writeFileSync(script, "process.exit(42);\n");

    try {
      const wrapperProc = fork(WRAPPER_PATH, ["--proxy-port", "0"], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: {
          ...process.env,
          CACHE_FIX_PROXY_BIND: "127.0.0.1",
          CACHE_FIX_CLAUDE_CMD: `${process.execPath} ${script}`,
        },
      });

      const code = await new Promise((resolve) => {
        wrapperProc.on("exit", (c) => resolve(c));
        setTimeout(() => { wrapperProc.kill("SIGTERM"); resolve(null); }, 15000);
      });

      assert.equal(code, 42);
    } finally {
      try { unlinkSync(script); } catch {}
    }
  });
});
