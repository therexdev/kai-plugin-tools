"use strict";
// This plugin owns the tool/account/developer interface and its native reviews.
const allPermissions = Object.freeze({"tools.ui.request":true,"tools.ui.poll":true,"tools.ui.cancel":true,"tools.payment":true});
function create(ctx) {
  const developer = require("./tools-developer").create(ctx);
  function assertSettings() { ctx.environment.settings.all(); }
  const requests = require("./feature-requests").createFeatureRequests(ctx, "tools", async (input, signal) => {
    if (input.bodyBase64 !== undefined) throw Error("Tools accepts JSON requests only");
    const pathname = new URL(input.path, "http://127.0.0.1").pathname, method = String(input.method || "GET").toUpperCase();
    if (require("./tools-developer").isDeveloperPath(pathname)) { assertSettings(); await developer.authorize(input, signal); assertSettings(); return; }
    if (method === "GET") return;
    assertSettings();
    let body = {}; if (input.body) { try { body = typeof input.body === "string" ? JSON.parse(input.body) : input.body; } catch { throw Error("Invalid tool request"); } }
    let title, detail, reviewedRow;
    const serverId=pathname.match(/^\/core\/mcp\/([\w-]+)\/(?:connect|flags)$/)?.[1];
    if (serverId && (pathname.endsWith("/connect") || [body.trusted,body.autoConnect,body.localSafe].includes(true))) {
      const row=ctx.environment.settings.get("mcp.servers",[]).find(item=>item.id===serverId);if(!row)throw Error("Tool server no longer exists");
      reviewedRow=JSON.stringify(row);
      title=pathname.endsWith("/connect")?"Start tool server?":"Change tool server permissions?";
      detail=`${row.name}\n${row.transport==="stdio"?JSON.stringify({command:row.command,args:row.args})+"\nThis local program runs with your user account permissions.":row.url}`;
      if(body.trusted===true)detail+="\nAllow its tools to act without asking before each use.";
      if(body.autoConnect===true)detail+="\nStart this server automatically while the Tools plugin is enabled.";
      if(body.localSafe===true)detail+="\nAllow this program in Local-Only mode. Confirm it operates without network access.";
    } else if (pathname === "/core/email/send") { title = "Send email?"; detail = JSON.stringify(body, null, 2); }
    else if (pathname === "/core/calendar/create") { title = "Create calendar event?"; detail = JSON.stringify(body, null, 2); }
    if (title && !await ctx.confirm(title, detail)) throw Error("Action cancelled");
    signal.throwIfAborted();assertSettings();
    if(reviewedRow!==undefined&&JSON.stringify(ctx.environment.settings.get("mcp.servers",[]).find(item=>item.id===serverId))!==reviewedRow)throw Error("Tool server changed during review; review its current configuration again");
  });
  return { keepAliveOnWindowClose: true,
    async startBackground() { assertSettings(); await ctx.ensure?.("tools"); await ctx.environment.gateway.mcp?.autoConnect(); },
    call(method, input, signal) {
      if (method === "tools.payment") return developer.payment(input, signal);
      if (method.startsWith("tools.ui.") && Object.hasOwn(allPermissions, method)) return requests[method.slice(9)](input, signal);
      throw Error("Unknown Tools operation");
    },
    async dispose() { developer.dispose(); await requests.dispose(); },
  };
}
module.exports={create};
