"use strict";
function parseJson(text, kind) { let value; try { value = JSON.parse(text); } catch { throw Error(`Enter valid JSON for ${kind === "array" ? "arguments" : "tool arguments"}.`); } if (kind === "array" ? !Array.isArray(value) || value.some(v => typeof v !== "string") : !value || typeof value !== "object" || Array.isArray(value)) throw Error(kind === "array" ? "Arguments must be a JSON array of strings." : "Tool arguments must be a JSON object."); return value; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
if (typeof module !== "undefined") module.exports = { parseJson, escapeHtml };
if (typeof document !== "undefined") {
  const $ = id => document.getElementById(id), esc = escapeHtml;
  let state = {servers:[]}, catalog = [], busy = false, templateFolder = false;
  const banner = window.KaiPluginNotice.attach($("notice"), { focusTarget: () => document.querySelector('[data-tab][aria-selected="true"]') });
  function notice(message, error = false) { banner.show(message, { error, force: true }); }
  async function call(method, input = {}) { if (!window.kai?.call) throw Error("Open this plugin inside KAI Core 0.2.0 or later."); return window.kai.call(method, input); }
  async function action(fn, success = "") { if (busy) return; busy = true; for (const b of document.querySelectorAll("button:not(.kai-notice-close)")) b.disabled = true; notice("Waiting for Core…"); try { const result = await fn(); notice(result?.cancelled ? "Cancelled. No action was taken." : success); } catch(e) { notice(e.message || "The action failed.", true); } finally { busy = false; for (const b of document.querySelectorAll("button:not(.kai-notice-close)")) b.disabled = false; renderCatalog(); } }
  function tab(name) { $("servers").hidden = name === "inspect"; $("add").hidden = name === "inspect"; $("add").open = name === "add"; $("inspect").hidden = name !== "inspect"; for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === name)); if (name === "add") { $("add").scrollIntoView({ block: "nearest" }); $("name").focus(); } }
  for (const b of document.querySelectorAll("[data-tab]")) b.onclick = () => tab(b.dataset.tab);
  function render() {
    $("privacy").textContent = state.privacyMode || "Privacy unavailable"; $("localonly-note").hidden = state.privacyMode !== "local-only";
    $("server-list").innerHTML = state.servers.length ? state.servers.map(s => `<article class="tool-row"><div class="tool-row-head"><strong>${esc(s.name)}</strong><span class="muted">${s.transport === "stdio" ? "Runs on this machine" : "Web server"}</span><span class="status ${s.connected ? "connected" : ""}">${s.connected ? "Connected · " + s.tools.length + " tools" : "Not connected"}</span></div><p class="mini muted">${s.transport === "stdio" ? s.localSafe ? "Offline approved" : "Online mode required" : esc(s.url)}</p><div class="tool-controls"><button data-server="${esc(s.id)}" data-action="${s.connected ? "disconnect" : "connect"}">${s.connected ? "Disconnect" : "Connect"}</button>${s.connected ? `<button data-server="${esc(s.id)}" data-action="inspect">Explore tools</button>` : ""}<button class="danger" data-server="${esc(s.id)}" data-action="remove">Remove</button></div></article>`).join("") : '<div class="empty">No tool servers yet — add one below to make its tools available.</div>';
    for (const b of $("server-list").querySelectorAll("button")) b.onclick = () => { if (b.dataset.action === "inspect") { $("run-server").value = b.dataset.server; renderTools(); tab("inspect"); } else void action(async () => { const result = await call(`tools.${b.dataset.action}`, {id:b.dataset.server}); await refresh(); return result; }, "Server updated."); };
    const prior = $("run-server").value;
    $("run-server").innerHTML = '<option value="">Select a connected server</option>' + state.servers.filter(s => s.connected).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
    if (state.servers.some(s => s.connected && s.id === prior)) $("run-server").value = prior;
    renderTools(); renderCatalog();
  }
  function renderTools() { const server = state.servers.find(s => s.id === $("run-server").value), old = $("run-tool").value; $("run-tool").innerHTML = '<option value="">Select a tool</option>' + (server?.tools || []).map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join(""); if (server?.tools.some(t => t.name === old)) $("run-tool").value = old; renderTool(); }
  function renderTool() { const tool = state.servers.find(s => s.id === $("run-server").value)?.tools.find(t => t.name === $("run-tool").value); $("tool-description").textContent = tool?.description || "Connect a server, then choose one of its tools."; $("tool-schema").textContent = JSON.stringify(tool?.inputSchema || {}, null, 2); }
  async function refresh() { state = await call("tools.status"); render(); }
  function transport() { const stdio = $("transport").value === "stdio"; $("stdio-fields").hidden = !stdio; $("http-fields").hidden = stdio; $("command").required = stdio; $("url").required = !stdio; }
  $("transport").onchange = transport; $("run-server").onchange = renderTools; $("run-tool").onchange = renderTool;
  $("refresh").onclick = () => action(refresh); $("cancel-add").onclick = () => tab("servers");
  $("server-form").onsubmit = event => { event.preventDefault(); void action(async () => { const input = {name:$("name").value,transport:$("transport").value,localSafe:$("local-safe").checked}; if (input.transport === "http") input.url = $("url").value; else { input.command = $("command").value; input.args = parseJson($("args").value,"array"); if (templateFolder) { if (!$("folder").value.trim()) throw Error("Enter the full folder path for this template."); input.args.push($("folder").value.trim()); } } const result = await call("tools.add",input); if (!result.cancelled) { $("server-form").reset(); templateFolder = false; $("folder-label").hidden = true; transport(); await refresh(); tab("servers"); } return result; }, "Saved. Connect the server when you are ready."); };
  $("tool-form").onsubmit = event => { event.preventDefault(); void action(async () => { if (!$("run-server").value || !$("run-tool").value) throw Error("Select a connected server and a tool first."); const result = await call("tools.call", {id:$("run-server").value,name:$("run-tool").value,args:parseJson($("tool-args").value,"object")}); if (!result.cancelled) $("result").textContent = result.result; return result; }, "Tool completed."); };
  const runtime = install => action(async () => { const result = await call("tools.runtime",{install}); if (!result.cancelled) $("runtime-status").textContent = result.available ? `${result.source} · ${result.version || "Ready"}` : result.installable ? "Runtime available to download" : "No runtime build is available for this platform. Install Node on your system."; return result; });
  $("runtime-check").onclick = () => runtime(false); $("runtime-install").onclick = () => runtime(true);
  function renderCatalog() {
    const keep = $("catalog-select").value, names = new Set(state.servers.map(server => server.name));
    const available = catalog.filter(entry => !names.has(entry.name));
    $("catalog-select").innerHTML = available.length ? available.map(entry => `<option value="${esc(entry.id)}">${esc(entry.name)}</option>`).join("") : '<option value="">No additional catalog servers</option>';
    if (available.some(entry => entry.id === keep)) $("catalog-select").value = keep;
    $("catalog-select").disabled = !available.length; $("catalog-add").disabled = !available.length;
    describeCatalog();
  }
  function describeCatalog() { const entry = catalog.find(item => item.id === $("catalog-select").value); $("catalog-description").textContent = entry?.description || "Add your own MCP server below."; }
  $("catalog-select").onchange = describeCatalog;
  $("catalog-add").onclick = () => {
    const c = catalog.find(entry => entry.id === $("catalog-select").value); if (!c) return;
    $("name").value = c.name; $("transport").value = c.transport; $("command").value = c.command || ""; $("url").value = c.url || ""; $("args").value = JSON.stringify(c.args || [], null, 2); $("local-safe").checked = false;
    templateFolder = !!c.argsPrompt; $("folder-label").hidden = !templateFolder; $("folder").value = ""; transport(); tab("add");
  };
  void action(async () => { await refresh(); catalog = await call("tools.catalog"); renderCatalog(); });
}
