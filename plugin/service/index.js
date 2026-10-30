"use strict";
const fs=require("node:fs"),path=require("node:path");
const {createTransport,execution}=require("./transport"),{Router}=require("./router");
function create(api) {
 const dataDir=api.plugin.dataDir;fs.mkdirSync(dataDir,{recursive:true});let closed=false;
 const settings={all:()=>structuredClone(api.settings.get("tools",{})),get(key,fallback){let value=this.all();for(const part of key.split("."))value=value?.[part];return value===undefined?fallback:value;},set(key,value){const data=this.all(),parts=key.split(".");if(parts.some(p=>["__proto__","prototype","constructor"].includes(p)))throw Error("Invalid setting key");let cursor=data;for(const part of parts.slice(0,-1)){if(!cursor[part]||typeof cursor[part]!=="object")cursor[part]={};cursor=cursor[part];}cursor[parts.at(-1)]=structuredClone(value);api.settings.set("tools",data);}};
 const models={aliases:()=>api.models.list()},network={status:()=>api.network.status()},runtime={status:()=>api.runtime?.status?.()||{}};
 const provisioner=new(require("./core/lib/runtime-provisioner").RuntimeProvisioner)({catalogPath:path.join(__dirname,"node-catalog.json"),runtimesDir:path.join(dataDir,"runtimes"),onEvent:event=>{try{api.log?.("info",event.type);}catch{}}});
 const provision=provisioner.ensure.bind(provisioner);provisioner.ensure=(kind,options={})=>{if(network.status().privacyMode==="local-only")throw Error("Local-Only blocks runtime downloads");return provision(kind,{...options,signal:AbortSignal.any([api.signal,...[options.signal].filter(Boolean)])});};
 runtime.provisioner=provisioner;
 const nodeRuntime=new(require("./core/lib/node-runtime").NodeRuntime)({provisioner,runtimesDir:path.join(dataDir,"runtimes")});
 const registry=new(require("./core/lib/tools").ToolRegistry)({privacyMode:()=>network.status().privacyMode});
 const builtin=require("./core/lib/builtin-tools").registerBuiltinTools(registry,{dataDir,nodeRuntime});
 const originalCall=registry.call.bind(registry);
 registry.call=async(name,args,options={})=>{
  const signal=options.signal||execution.getStore()?.signal||api.signal;signal?.throwIfAborted();if(closed)throw Error("Tools is stopped");
  const tool=registry._tools.get(name);if(tool?.sensitive&&options.confirmed===true){const snapshot=tool;const detail=JSON.stringify({tool:name,input:args},null,2);if(detail.length>24000)throw Error("Tool arguments are too large to review");if(!await api.desktop.confirm("Run tool?",detail+(name==="run_code"?"\nThis executes local code with your user permissions. Runtime restrictions are not a security sandbox.":"")))throw Error("Tool action cancelled");signal?.throwIfAborted();if(registry._tools.get(name)!==snapshot)throw Error("Tool changed during review");}
  return execution.run({...execution.getStore(),signal},()=>originalCall(name,args,{...options,signal}));
 };
 const chatFn=async({model,messages,maxTokens,signal})=>{const current=signal||execution.getStore()?.signal||api.signal;current?.throwIfAborted();const response=await api.models.chat({model,messages,max_tokens:maxTokens,stream:false},current);current?.throwIfAborted();return response.choices?.[0]?.message?.content||response.text||"";};
 const teams=new(require("./core/lib/teams").TeamRunner)({registry,chatFn});
 const {GroupChatRunner,GroupDefs}=require("./core/lib/groupchat");
 const definitions=path.join(dataDir,"agent-teams.json");if(fs.existsSync(definitions)){const st=fs.lstatSync(definitions);if(!st.isFile()||st.isSymbolicLink()||st.size>8*1024*1024||!Array.isArray(JSON.parse(fs.readFileSync(definitions,"utf8"))))throw Error("Saved team definitions need recovery");}
 const agents={runner:new GroupChatRunner({registry,chatFn}),defs:new GroupDefs(definitions),registry};
 const bench=new(require("./core/lib/bench").BenchRunner)({chatFn,teams,dataDir});
 const dev={status:()=>({enabled:settings.get("dev.tools",false)===true}),configure:({enabled})=>{settings.set("dev.tools",enabled===true);return dev.status();}};
 const pendingClose=new Set(),{OwnedConnection}=require("./electron/plugin-services/mcp-connection");let mcp;
 class Connection extends OwnedConnection {constructor(config,onEvent){super(config,event=>{onEvent(event);if(event.type==="mcp:exited"&&mcp?._conns.get(config.id)===this)mcp.disconnect(config.id);});}close(){const task=Promise.resolve(super.close());pendingClose.add(task);task.finally(()=>pendingClose.delete(task));return task;}}
 mcp=new(require("./core/lib/mcp-manager").McpManager)({settings,registry,nodeRuntime,Connection,onEvent:event=>{try{api.log?.("info",event.type);}catch{}}});
 const canConnect=row=>network.status().privacyMode!=="local-only"||row?.transport==="stdio"&&row.localSafe===true;
 const connect=mcp.connect.bind(mcp);mcp.connect=id=>{if(!canConnect(settings.get("mcp.servers",[]).find(s=>s.id===id)))throw Error("Local-Only blocks this tool server");return connect(id);};
 const {EmailService,registerEmailTools}=require("./core/lib/email"),{CalendarService,registerCalendarTools}=require("./core/lib/caldav");
 const email=new EmailService({dataDir,safeStorage:api.secrets}),calendar=new CalendarService({dataDir,safeStorage:api.secrets});
 registerEmailTools(registry,email);registerCalendarTools(registry,calendar);
 const gateway={models,runtime,network,tools:registry,nodeRuntime,mcp,email,calendar,teams,agents,bench,dev};
 const environment={gateway,models,runtime,settings};
 const router=new Router({...gateway,track:obj=>{const id=obj.trace?.runId||obj.runId;if(id)execution.getStore()?.record.runs.add(id);}});
 const transport=createTransport({signal:api.signal,route:(req,res)=>router.route(req,res),onStop:record=>{for(const id of record.runs)agents.runner.stop(id);}});
 const paid=require("./paid-runs").createPaidRuns(api,environment,registry);
 const ctx={dataDir,environment,ensure:async()=>gateway,confirm:(title,detail)=>api.desktop.confirm(title,detail),getWindow:()=>require("electron").BrowserWindow.fromId(api.desktop.hostWindowId()),getWebContents:()=>require("electron").webContents.fromId(api.desktop.rendererId()),isVisible:()=>api.desktop.isVisible(),runPayment:(...args)=>paid.run(...args),request:(_feature,input,signal)=>transport.request(input,signal),poll:(_feature,id,signal)=>transport.poll(id,signal),cancel:(_feature,id)=>transport.cancel(id),release:async()=>transport.dispose()};
 const controller=require("./electron/plugin-services/tools").create(ctx);
 const apiCall=async(method,input,signal)=>{if(closed)throw Error("Tools is stopped");api.signal?.throwIfAborted();signal?.throwIfAborted();if(method==="tools.paymentEvents")return paid.events(input);return controller.call(method,input,signal||api.signal);};
 const unprovide=api.services.provide("kai.tools",{methods:["request","poll","cancel","list","call","payment","paymentEvents"],call(method,input,context){const signal=context?.signal;if(method==="list")return {tools:registry.list()};if(method==="call")return registry.call(String(input?.name||""),input?.args||{},{confirmed:input?.confirmed===true,signal});if(method==="payment")return apiCall("tools.payment",input,signal);if(method==="paymentEvents")return paid.events(input);return apiCall("tools.ui."+method,input,signal);}});
 return {call:apiCall,startBackground:()=>controller.startBackground(),async privacyChanged(mode){if(mode==="local-only"){for(const row of settings.get("mcp.servers",[]))if(!canConnect(row))mcp.disconnect(row.id);await Promise.allSettled([...pendingClose]);}},async dispose(){closed=true;unprovide?.();paid.dispose();for(const id of agents.runner._runs.keys())agents.runner.stop(id);mcp.closeAll();email.dispose();builtin.codeRunner?.stopAll?.();await Promise.allSettled([controller.dispose(),...pendingClose]);}};
}
module.exports={create};
