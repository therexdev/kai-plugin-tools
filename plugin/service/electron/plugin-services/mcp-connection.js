"use strict";
// Keep the original MCP protocol, catalog and manager semantics, with owned
// process groups and abortable HTTP for the independently installed plugin.
const { spawn } = require("node:child_process");
const { McpConnection } = require("../../core/lib/mcp");
const cleanEnv = extra => Object.fromEntries(Object.entries(extra || process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL)$/i.test(key)));
class OwnedConnection extends McpConnection {
  constructor(config, onEvent) {
    if (config.shell) throw Error("Install the Node runtime so this tool server can run directly without a shell");
    const command = Array.isArray(config.command) ? config.command : String(config.command || "").split(" ").filter(Boolean);
    super({ ...config, command }, onEvent); this.abort = new AbortController(); this.done = Promise.resolve(); }
  _stdioStart() {
    const child = this._child = spawn(this.config.command[0], [...this.config.command.slice(1), ...(this.config.args || [])], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, env: cleanEnv(this.config.env), detached: process.platform !== "win32" });
    this.pid = child.pid;
    this.done = new Promise(resolve => child.once("close", resolve));
    const rejectAll = error => { for (const p of this._pending.values()) { clearTimeout(p.timer); p.reject(error); } this._pending.clear(); };
    const decoder = new (require("node:string_decoder").StringDecoder)("utf8");
    child.stdout.on("data", chunk => {
      this._buf += decoder.write(chunk);
      if (Buffer.byteLength(this._buf) > 2 * 1024 * 1024) { rejectAll(Error("MCP response exceeds 2 MB")); void this.close(); return; }
      let boundary;
      while ((boundary = this._buf.indexOf("\n")) >= 0) {
        const line = this._buf.slice(0, boundary).trim(); this._buf = this._buf.slice(boundary + 1);
        try { const message = JSON.parse(line), pending = this._pending.get(message.id); if (!pending) continue; clearTimeout(pending.timer); this._pending.delete(message.id); message.error ? pending.reject(Error("MCP operation failed")) : pending.resolve(message.result); } catch { /* ignore diagnostic lines */ }
      }
    });
    child.stderr.on("data", () => {}); child.stdin.on("error", () => {});
    child.on("error", () => { rejectAll(Error("The local tool server could not start. Check its executable and arguments.")); });
    child.on("exit", code => { this._child = null; rejectAll(Error("The local tool server stopped")); this.onEvent({ type: "mcp:exited", server: this.config.name, code }); void this.close(); });
  }
  async _httpRpc(method, params, { notification = false, timeoutMs = 30000 } = {}) {
    const body = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }), ...(notification ? {} : { id: this._nextId++ }) };
    const response = await fetch(this.config.url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(this._sessionId ? { "mcp-session-id": this._sessionId } : {}) }, body: JSON.stringify(body), signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]) });
    const sessionId = response.headers.get("mcp-session-id"); if (sessionId) this._sessionId = sessionId;
    if (!response.ok) { await response.body?.cancel(); throw Error(`MCP server answered HTTP ${response.status}`); }
    if (notification) { await response.body?.cancel(); return null; }
    const sse = response.headers.get("content-type")?.includes("text/event-stream"); let text = "", bytes = 0, message;
    function parse(frame) { try { const value = JSON.parse(frame); return value.id === body.id ? value : null; } catch { return null; } }
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw Error("MCP response exceeds 2 MB"); text += decoder.decode(chunk, { stream: true });
      if (sse) { let split; while ((split = /\r?\n\r?\n/.exec(text))) { const frame = text.slice(0, split.index); text = text.slice(split.index + split[0].length); message = parse(frame.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n")); if (message) break; } if (message) break; }
    }
    if (sse && !message) message = parse((text + decoder.decode()).split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n"));
    if (!sse) message = parse(text + decoder.decode());
    if (!message) throw Error("MCP response did not match the request"); if (message.error) throw Error("MCP operation failed"); return message.result;
  }
  close() {
    if (this.closing) return this.closing;
    this.abort.abort(); for (const p of this._pending.values()) { clearTimeout(p.timer); p.reject(Error("Tool server disconnected")); } this._pending.clear();
    const child = this._child, pid = this.pid; this._child = null; this.pid = null;
    this.closing = (async () => {
      if (pid) {
        if (process.platform === "win32") await new Promise(resolve => { const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore", env: cleanEnv() }); let timer; const done = () => { clearTimeout(timer); resolve(); }; killer.on("error", done); killer.on("close", done); timer = setTimeout(() => { killer.kill(); done(); }, 4000); timer.unref(); });
        else { try { process.kill(-pid, "SIGTERM"); } catch { try { child?.kill(); } catch {} } }
      }
      let timer; await Promise.race([this.done, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); clearTimeout(timer);
      if (pid && process.platform !== "win32") { try { process.kill(-pid, "SIGKILL"); } catch {} }
    })(); return this.closing;
  }
}
module.exports = { OwnedConnection, cleanEnv };
