"use strict";
// Feature-owned request handlers. No listener or Core gateway is created.
const FORWARDED_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host"];
class Router {
 constructor(services) { Object.assign(this,services); }
 async _readBody(req) { const chunks=[]; let bytes=0; for await(const c of req) {bytes+=c.length;if(bytes>4*1024*1024)throw Error("Request is too large");chunks.push(c);}return Buffer.concat(chunks); }
 _json(res,status,body) {res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(body));}
 async route(req,res) {
 const url=new URL(req.url,"http://plugin.invalid"), path=url.pathname;
 if(path==="/core/models"&&req.method==="GET")return this._json(res,200,{ok:true,aliases:this.models.aliases(),runtime:this.runtime.status()});
 if(path==="/core/network"&&req.method==="GET")return this._json(res,200,this.network.status());
    if (this.tools && path === "/core/tools" && req.method === "GET") {
      return this._json(res, 200, { ok: true, tools: this.tools.list() });
    }
    if (this.tools && path === "/core/tools/call" && req.method === "POST") {
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      const abort = new AbortController();
      const closed = () => { if (!res.writableEnded) abort.abort(); };
      res.on("close", closed);
      try {
        const result = await this.tools.call(String(body.name || ""), body.args || {}, { confirmed: Boolean(body.confirmed), signal: abort.signal });
        return this._json(res, 200, { ok: true, result });
      } catch (e) {
        return this._json(res, e.needsConfirmation ? 428 : 400, {
          ok: false,
          error: String(e.message),
          ...(e.needsConfirmation ? { needsConfirmation: true } : {}),
        });
      } finally { res.off("close", closed); }
    }


    if (this.mcp && path === "/core/mcp" && req.method === "GET") {
      const { CATALOG } = require("./core/lib/mcp-manager");
      return this._json(res, 200, {
        ok: true,
        servers: this.mcp.servers(),
        catalog: CATALOG,
        // The UI turns this into a "Set up (≈N MB)" button instead of a
        // dead-end "install Node.js yourself" message.
        node: this.nodeRuntime ? this.nodeRuntime.status() : { available: false, installable: false },
      });
    }
    if (this.nodeRuntime && path === "/core/mcp/runtime" && req.method === "POST") {
      try {
        return this._json(res, 200, { ok: true, node: await this.nodeRuntime.ensure() });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }
    if (this.mcp && path === "/core/mcp" && req.method === "POST") {
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      try {
        return this._json(res, 200, { ok: true, server: this.mcp.addServer(body) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }
    if (this.mcp && /^\/core\/mcp\/[^/]+\/(connect|disconnect|flags)$/.test(path) && req.method === "POST") {
      const [, , , id, action] = path.split("/");
      try {
        if (action === "connect") {
          const tools = await this.mcp.connect(id);
          return this._json(res, 200, { ok: true, tools });
        }
        if (action === "disconnect") {
          this.mcp.disconnect(id);
          return this._json(res, 200, { ok: true });
        }
        const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
        return this._json(res, 200, { ok: true, server: this.mcp.setServerFlags(id, body) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }
    if (this.mcp && /^\/core\/mcp\/[^/]+$/.test(path) && req.method === "DELETE") {
      this.mcp.removeServer(path.split("/")[3]);
      return this._json(res, 200, { ok: true });
    }

    // ---- email + calendar (egress by definition: same Local-Only refusal
    // contract as /core/search — checked here so even the UI views obey) ----
    if ((this.email && path.startsWith("/core/email")) || (this.calendar && path.startsWith("/core/calendar"))) {
      const mode = this.network ? this.network.status().privacyMode : "local-only";
      const isStatus = req.method === "GET" && (path === "/core/email" || path === "/core/calendar");
      if (mode === "local-only" && !isStatus) {
        return this._json(res, 403, { ok: false, error: "Privacy mode is Local-Only: email and calendar talk to servers and are disabled" });
      }
      try {
        if (path === "/core/email" && req.method === "GET") return this._json(res, 200, { ok: true, ...this.email.status(), localOnly: mode === "local-only" });
        if (path === "/core/email/config" && req.method === "POST") {
          const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
          return this._json(res, 200, { ok: true, ...this.email.saveConfig(body) });
        }
        if (path === "/core/email/config" && req.method === "DELETE") {
          this.email.removeConfig();
          return this._json(res, 200, { ok: true });
        }
        if (path === "/core/email/inbox" && req.method === "GET") return this._json(res, 200, { ok: true, messages: await this.email.inbox() });
        if (path === "/core/email/message" && req.method === "GET") return this._json(res, 200, { ok: true, message: await this.email.read(Number(url.searchParams.get("uid"))) });
        if (path === "/core/email/send" && req.method === "POST") {
          // Reached only from the compose UI after an explicit user click —
          // sending is deliberately NOT an agent tool.
          const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
          return this._json(res, 200, { ok: true, ...(await this.email.send(body)) });
        }
        if (path === "/core/calendar" && req.method === "GET") return this._json(res, 200, { ok: true, ...this.calendar.status(), localOnly: mode === "local-only" });
        if (path === "/core/calendar/config" && req.method === "POST") {
          const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
          return this._json(res, 200, { ok: true, ...this.calendar.saveConfig(body) });
        }
        if (path === "/core/calendar/config" && req.method === "DELETE") {
          this.calendar.removeConfig();
          return this._json(res, 200, { ok: true });
        }
        if (path === "/core/calendar/events" && req.method === "GET") {
          return this._json(res, 200, { ok: true, events: await this.calendar.events(Number(url.searchParams.get("days")) || 14) });
        }
        if (path === "/core/calendar/create" && req.method === "POST") {
          const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
          return this._json(res, 200, { ok: true, event: await this.calendar.create(body) });
        }
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }


    if (this.teams && path === "/core/teams" && req.method === "GET") {
      return this._json(res, 200, { ok: true, templates: this.teams.templates() });
    }
    if (this.teams && path === "/core/teams/run" && req.method === "POST") {
      let body;
      try {
        body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      } catch {
        return this._json(res, 400, { ok: false, error: "Body must be JSON" });
      }
      // Custom JSON specs are a developer-tools feature (task #61): same
      // budgets and permissions as the templates, but behind the explicit
      // switch so the surprise surface stays away from non-developers.
      if (body.spec !== undefined && !(this.dev && this.dev.status().enabled)) {
        return this._json(res, 403, { ok: false, error: "Custom team specs need Developer tools on (Local API → Developer tools)." });
      }
      // SSE: one event per trace entry, then a terminal done event. The
      // sensitive-tool consent arrives as an explicit boolean from the
      // caller (the UI asks the human up front; API callers state it).
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      const send = (obj) => { this.track?.(obj); return res.write(`data: ${JSON.stringify(obj)}\n\n`); };
      try {
        const r = await this.teams.run({
          template: String(body.template || ""),
          spec: body.spec,
          question: String(body.question || ""),
          model: String(body.model || ""),
          allowSensitive: body.allowSensitive === true,
          onTrace: (e) => send({ trace: e }),
        });
        send({ done: true, answer: r.answer, modelCalls: r.modelCalls });
      } catch (e) {
        send({ done: true, error: String(e.message) });
      }
      return res.end();
    }

    // ---- Developer tools (task #61): one explicit switch, stored in settings ----
    if (this.dev && path === "/core/dev" && req.method === "GET") {
      return this._json(res, 200, { ok: true, ...this.dev.status() });
    }
    if (this.dev && path === "/core/dev" && req.method === "POST") {
      let body;
      try {
        body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      } catch {
        return this._json(res, 400, { ok: false, error: "Body must be JSON" });
      }
      return this._json(res, 200, { ok: true, ...this.dev.configure({ enabled: body.enabled === true }) });
    }

    // ---- Bench (task #61): fixed objective suite, scored mechanically ----
    if (this.bench && path === "/core/bench" && req.method === "GET") {
      return this._json(res, 200, { ok: true, suites: this.bench.suites(), enabled: this.dev ? this.dev.status().enabled : false });
    }
    if (this.bench && path === "/core/bench/run" && req.method === "POST") {
      if (!(this.dev && this.dev.status().enabled)) {
        return this._json(res, 403, { ok: false, error: "The benchmark needs Developer tools on (Local API → Developer tools)." });
      }
      let body;
      try {
        body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      } catch {
        return this._json(res, 400, { ok: false, error: "Body must be JSON" });
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      const send = (obj) => { this.track?.(obj); return res.write(`data: ${JSON.stringify(obj)}\n\n`); };
      try {
        const r = await this.bench.run({
          suite: String(body.suite || "core"),
          model: String(body.model || ""),
          onCase: (row) => send({ case: row }),
        });
        send({ done: true, summary: r.summary });
      } catch (e) {
        send({ done: true, error: String(e.message) });
      }
      return res.end();
    }

    // ---- Multi-agent group chats (task #64): the full-AutoGen track ----
    if (this.agents && path.startsWith("/core/agents/")) {
      if (!(this.dev && this.dev.status().enabled)) {
        return this._json(res, 403, { ok: false, error: "Multi-agent teams need Developer tools on (Local API → Developer tools)." });
      }
      if (path === "/core/agents/defs" && req.method === "GET") {
        return this._json(res, 200, { ok: true, defs: this.agents.defs.list() });
      }
      if (path === "/core/agents/defs" && req.method === "POST") {
        let body;
        try {
          body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
        } catch {
          return this._json(res, 400, { ok: false, error: "Body must be JSON" });
        }
        try {
          const known = this.agents.registry ? this.agents.registry.list().map((t) => t.name) : null;
          const entry = this.agents.defs.save({ id: body.id, spec: body.spec }, known);
          return this._json(res, 200, { ok: true, def: entry });
        } catch (e) {
          return this._json(res, 400, { ok: false, error: String(e.message) });
        }
      }
      const del = path.match(/^\/core\/agents\/defs\/([\w-]+)$/);
      if (del && req.method === "DELETE") {
        return this._json(res, 200, { ok: true, removed: this.agents.defs.remove(del[1]) });
      }
      if (path === "/core/agents/input" && req.method === "POST") {
        let body;
        try {
          body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
        } catch {
          return this._json(res, 400, { ok: false, error: "Body must be JSON" });
        }
        const took = this.agents.runner.provideInput(String(body.inputId || ""), String(body.text ?? ""));
        return this._json(res, took ? 200 : 404, took ? { ok: true } : { ok: false, error: "no such pending input — it may have timed out" });
      }
      if (path === "/core/agents/stop" && req.method === "POST") {
        let body;
        try {
          body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
        } catch {
          return this._json(res, 400, { ok: false, error: "Body must be JSON" });
        }
        return this._json(res, 200, { ok: true, stopped: this.agents.runner.stop(String(body.runId || "")) });
      }
      if (path === "/core/agents/run" && req.method === "POST") {
        let body;
        try {
          body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
        } catch {
          return this._json(res, 400, { ok: false, error: "Body must be JSON" });
        }
        let spec = body.spec;
        if (!spec && body.defId) {
          const def = this.agents.defs.get(body.defId);
          if (!def) return this._json(res, 404, { ok: false, error: "no saved team with that id" });
          spec = def.spec;
        }
        // SSE with input-request events: the run PAUSES on human agents and
        // resumes when /core/agents/input answers. Consent for sensitive
        // tools arrives upfront, exactly like teams.
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const send = (obj) => { this.track?.(obj); return res.write(`data: ${JSON.stringify(obj)}\n\n`); };
        try {
          const r = await this.agents.runner.run({
            spec,
            task: String(body.task || ""),
            model: String(body.model || ""),
            allowSensitive: body.allowSensitive === true,
            onTrace: (e) => send({ trace: e }),
          });
          send({ done: true, transcript: r.transcript, modelCalls: r.modelCalls, reason: r.reason });
        } catch (e) {
          send({ done: true, error: String(e.message) });
        }
        return res.end();
      }
      return this._json(res, 404, { ok: false, error: "unknown /core/agents route" });
    }


 return this._json(res,404,{ok:false,error:"Unknown plugin operation"});
 }
}
module.exports={Router};
