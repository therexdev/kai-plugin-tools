"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const { systemNodePath } = require("./node-runtime");

/*
 * Reviewed local script execution. Node permission flags, environment filtering,
 * network module restrictions, timeouts and output limits are defense in depth,
 * not a malicious-code sandbox. This native plugin has full computer access.
 * The exact code requires native user approval before execution.
 */

const DEFAULT_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_SEC = 120;
const MAX_CODE_BYTES = 100_000;
const MAX_STREAM_BYTES = 32_768; // per stream, then truncated with a marker
const HEAP_MB = 256;

/** Which node binary runs sandboxed scripts, and with what extra env.
 *  Managed copy first (a known-real node), then this very process when it is
 *  one (headless Core), then Electron-as-node. */
function nodeBinFor(nodeRuntime) {
  const managed = nodeRuntime?.installedPath?.();
  if (managed) return { bin: managed, env: {} };
  if (!process.versions.electron) return { bin: process.execPath, env: {} };
  const sys = systemNodePath();
  if (sys) return { bin: sys, env: {} };
  // Electron binaries become plain node under this env var.
  return { bin: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** The permission flag this node accepts, or null when it has none.
 *  (--permission stabilized after --experimental-permission; support both.) */
function permissionFlagFor(bin, extraEnv) {
  for (const flag of ["--permission", "--experimental-permission"]) {
    try {
      const r = spawnSync(bin, [flag, "--allow-fs-read=*", "-e", "0"], {
        env: { ...minimalEnv(), ...extraEnv },
        timeout: 10000,
        windowsHide: true,
      });
      if (r.status === 0) return flag;
    } catch {
      /* try the next spelling */
    }
  }
  return null;
}

function minimalEnv() {
  // PATH only — node itself needs nothing else, and everything else
  // (proxies, tokens, real HOME) is exactly what must not leak in.
  return { PATH: process.env.PATH || "" };
}

class CodeRunner {
  constructor({ workspaceDir, nodeRuntime = null }) {
    // Node's permission model resolves the entry script before executing it.
    // On macOS os.tmpdir() is commonly spelled /var/... while its canonical
    // location is /private/var/...; allowing only the symlink spelling makes
    // Node stop at realpath("/var") before the sandboxed script can start.
    // Canonicalising the already-created workspace keeps the allow-list just
    // as narrow while giving Node the exact path it will resolve internally.
    this.workspaceDir = fs.realpathSync(path.resolve(workspaceDir));
    this.nodeRuntime = nodeRuntime;
    this.preload = fs.realpathSync(path.join(__dirname, "sandbox-preload.cjs"));
    this.children = new Set();
    this._resolved = null; // { bin, env, flag } — probed once, lazily
  }

  /** Probe the runtime once. Returns { ok } or { ok:false, reason }. */
  availability() {
    if (!this._resolved) {
      const { bin, env } = nodeBinFor(this.nodeRuntime);
      const flag = permissionFlagFor(bin, env);
      this._resolved = { bin, env, flag };
    }
    if (!this._resolved.flag) {
      return {
        ok: false,
        reason:
          "this machine's Node runtime cannot sandbox code (needs the permission model, Node 20+) — code execution stays OFF rather than running unjailed",
      };
    }
    return { ok: true };
  }

  /**
   * Run one script. Returns a text report shaped for a model to read:
   * exit status, wall time, then the captured output.
   */
  async run(code, { timeoutSec, signal } = {}) {
    signal?.throwIfAborted();
    const avail = this.availability();
    if (!avail.ok) throw new Error(avail.reason);
    const src = String(code ?? "");
    if (!src.trim()) throw new Error("no code to run");
    if (Buffer.byteLength(src) > MAX_CODE_BYTES) throw new Error("script too large (100 KB cap)");
    const timeoutMs = Math.min(Math.max(1, Number(timeoutSec) || DEFAULT_TIMEOUT_SEC), MAX_TIMEOUT_SEC) * 1000;

    const { bin, env, flag } = this._resolved;
    const runDir = path.join(this.workspaceDir, ".runs", crypto.randomBytes(6).toString("hex"));
    fs.mkdirSync(runDir, { recursive: true });
    const scriptPath = path.join(runDir, "script.cjs");
    fs.writeFileSync(scriptPath, src);

    // Read: workspace (script + preload + the files the other tools made).
    // Write: workspace only. Nothing else exists as far as fs is concerned.
    const args = [
      flag,
      `--allow-fs-read=${this.workspaceDir}`,
      `--allow-fs-read=${this.preload}`,
      `--allow-fs-write=${this.workspaceDir}`,
      `--max-old-space-size=${HEAP_MB}`,
      "--require",
      this.preload,
      scriptPath,
    ];

    const started = Date.now();
    const result = await new Promise((resolve) => {
      const child = spawn(bin, args, {
        cwd: this.workspaceDir,
        env: { ...minimalEnv(), ...env, HOME: runDir, NODE_OPTIONS: "" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.children.add(child);
      const abort = () => child.kill("SIGKILL");
      signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
      let out = "";
      let err = "";
      let killed = false;
      const cap = (cur, chunk) =>
        cur.length >= MAX_STREAM_BYTES ? cur : (cur + chunk).slice(0, MAX_STREAM_BYTES);
      child.stdout.on("data", (c) => (out = cap(out, String(c))));
      child.stderr.on("data", (c) => (err = cap(err, String(c))));
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer); this.children.delete(child); signal?.removeEventListener("abort",abort);
        resolve({ code: null, out, err: `${err}\nfailed to start: ${e.message}`, killed });
      });
      child.on("close", (code) => {
        clearTimeout(timer); this.children.delete(child); signal?.removeEventListener("abort",abort);
        resolve({ code, out, err, killed });
      });
    });

    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch { /* a locked temp file must not fail the run report */ }

    signal?.throwIfAborted();
    const secs = ((Date.now() - started) / 1000).toFixed(2);
    const mark = (s, name) =>
      s.length >= MAX_STREAM_BYTES ? `${s}\n…[${name} truncated at ${MAX_STREAM_BYTES} bytes]` : s;
    const head = result.killed
      ? `TIMED OUT after ${timeoutMs / 1000}s and was killed`
      : `exit ${result.code} in ${secs}s`;
    const parts = [head];
    if (result.out.trim()) parts.push(`--- stdout ---\n${mark(result.out, "stdout")}`);
    if (result.err.trim()) parts.push(`--- stderr ---\n${mark(result.err, "stderr")}`);
    if (!result.out.trim() && !result.err.trim()) parts.push("(no output — print what you need to see)");
    return parts.join("\n");
  }
  stopAll() { for (const child of this.children) child.kill("SIGKILL"); }
}

module.exports = { CodeRunner };
