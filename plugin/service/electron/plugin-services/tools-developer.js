"use strict";
// Developer Tools uses the original builders/engines, with a native review of
// the exact normalized team and tool registry before sensitive actions run.
const ROUTES = [
  ["GET", /^\/core\/(?:dev|models|network|tools|teams|bench|agents\/defs)$/],
  ["POST", /^\/core\/(?:dev|agents\/(?:defs|run|input|stop)|teams\/run|bench\/run)$/],
  ["DELETE", /^\/core\/agents\/defs\/[\w-]+$/],
];
const PAYMENT_ACTIONS = new Set(["chat-info", "run-open", "run-execute", "run-input", "run-list", "run-status", "run-stop", "stop"]);
function isDeveloperPath(path) { return /^\/core\/(?:dev|agents(?:\/|$)|teams(?:\/|$)|bench(?:\/|$))/.test(path); }
function create(ctx) {
  let closed = false;
  const active = signal => { signal?.throwIfAborted(); if (closed) throw Error("Developer tools are closing"); };
  async function review(title, detail, signal) {
    const text = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
    if (text.length > 10000) throw Error("This team is too large to review. Use a smaller specification or task.");
    if (!await ctx.confirm(title, text)) throw Error("Action cancelled"); active(signal);
  }
  async function prepareRun(path, source, signal, paid = false) {
    active(signal); await ctx.ensure("tools"); active(signal);
    const value = structuredClone(source), gateway = ctx.environment.gateway;
    if (!gateway.dev?.status().enabled) throw Error("Enable Developer tools first");
    if (!paid && (!ctx.environment.models.aliases().some(model => model.status === "ready" && model.alias === value.model) || /^(desktop:|koinos-network)/.test(value.model))) throw Error("Choose an installed local model, or select a network model with a total run budget");
    const registry = gateway.tools, available = registry.list(), known = available.map(tool => tool.name);
    let names = [], detail;
    if (path === "/core/agents/run") {
      const raw = value.spec || gateway.agents.defs.get(value.defId)?.spec;
      const spec = require("../../core/lib/groupchat").normalizeGroupSpec(raw, known);
      value.spec = spec; delete value.defId;
      names = [...new Set(spec.agents.flatMap(agent => agent.tools))];
      detail = { team: spec.label, task: value.task, model: value.model, specification: spec };
    } else if (path === "/core/teams/run") {
      const spec = value.spec ? require("../../core/lib/teams").normalizeSpec(value.spec, known) : gateway.teams.templates().find(row => row.id === value.template);
      if (!spec) throw Error("Choose a team or pipeline");
      value.spec = spec; delete value.template; names = spec.tools;
      detail = { pipeline: spec.label, task: value.question, model: value.model, specification: spec };
    }
    if (value.allowSensitive === true && names.length) {
      const snapshots = names.map(name => ({ name, tool: registry._tools.get(name), metadata: JSON.stringify(available.find(tool => tool.name === name)) }));
      if (snapshots.some(item => !item.tool)) throw Error("A selected tool is unavailable in the current privacy mode");
      if (names.some(name => available.find(tool => tool.name === name)?.sensitive)) {
        await review("Allow sensitive tools for this team run?", detail, signal);
        const latest = registry.list();
        if (gateway.tools !== registry || snapshots.some(item => registry._tools.get(item.name) !== item.tool || JSON.stringify(latest.find(tool => tool.name === item.name)) !== item.metadata)) throw Error("Tool configuration changed during review. Review this team again.");
      }
    }
    active(signal); return value;
  }
  return {
    async authorize(input, signal) {
      active(signal); const url = new URL(input.path, "http://127.0.0.1"), path = url.pathname, method = String(input.method || "GET").toUpperCase();
      if (!ROUTES.some(([verb, regex]) => verb === method && regex.test(path)) || url.search) throw Error("Unknown Developer tools operation");
      if (input.bodyBase64 !== undefined) throw Error("Developer tools accepts JSON only");
      const body = input.body ? typeof input.body === "string" ? JSON.parse(input.body) : input.body : {};
      if (!body || typeof body !== "object" || Array.isArray(body)) throw Error("Invalid Developer tools request");
      await ctx.ensure("tools"); active(signal);
      if (method === "GET") return;
      if (path === "/core/dev") {
        if (Object.keys(body).some(key => key !== "enabled") || typeof body.enabled !== "boolean") throw Error("Choose whether Developer tools is enabled");
        if (body.enabled) await review("Enable Developer tools?", "Show the original multi-agent builders, playground, custom pipelines and model benchmark. Enabling this view does not authorize any tools or network charges.", signal);
      } else if (method === "DELETE") {
        const id = path.split("/").at(-1), saved = ctx.environment.gateway.agents.defs.get(id);
        if (!saved) throw Error("This saved team no longer exists");
        const snapshot = JSON.stringify(saved);
        await review("Delete saved team?", { team: saved.label, specification: saved.spec }, signal);
        if (JSON.stringify(ctx.environment.gateway.agents.defs.get(id)) !== snapshot) throw Error("This team changed during review. Reopen it before deleting.");
      } else if (["/core/agents/run", "/core/teams/run", "/core/bench/run"].includes(path)) input.body = await prepareRun(path, body, signal);
      active(signal);
    },
    async payment(input, signal) {
      active(signal);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["action", "input"].includes(key)) || !PAYMENT_ACTIONS.has(input.action)) throw Error("Unknown Developer tools credit action");
      let value = structuredClone(input.input);
      if (input.action === "run-open") {
        if (!["team", "agents"].includes(value?.mode)) throw Error("Choose a team or multi-agent run");
        await ctx.ensure("tools"); active(signal);
        if (!ctx.environment.gateway.dev?.status().enabled) throw Error("Enable Developer tools before opening a run budget");
      }
      if (input.action === "run-execute") {
        if (!["team", "agents"].includes(value?.kind) || !value.body) throw Error("Choose a team or multi-agent run");
        value.body = await prepareRun(value.kind === "team" ? "/core/teams/run" : "/core/agents/run", value.body, signal, true);
      }
      if (!ctx.runPayment) throw Error("Network credit runs are unavailable");
      return ctx.runPayment(input.action, value, { signal });
    },
    dispose() { closed = true; },
  };
}
module.exports = { create, isDeveloperPath, ROUTES, PAYMENT_ACTIONS };
