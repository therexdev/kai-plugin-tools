"use strict";
const crypto=require("node:crypto");
const {TeamRunner}=require("./core/lib/teams"),{GroupChatRunner}=require("./core/lib/groupchat");
function createPaidRuns(api,environment,registry) {
 const active=new Map(),events=new Map();let closed=false;
 const digest=id=>{if(typeof id!=="string"||!/^[a-f0-9]{64}$/.test(id))throw Error("Invalid credit run");return id;};
 const emit=(id,trace)=>{const list=events.get(id)||[];list.push({sequence:(list.at(-1)?.sequence||0)+1,trace});if(list.length>1000)list.shift();events.set(id,list);api.desktop.send("koin:chat-progress",{runId:id,trace});};
 const stop=id=>{const state=active.get(id);state?.abort.abort();if(state?.localId)state.runner?.stop(state.localId);};
 return {
  events({runId,after=0}) {digest(runId);return {events:(events.get(runId)||[]).filter(e=>e.sequence>after),running:active.has(runId)};},
  async run(action,input,options={}) {
   if(closed)throw Error("Tools is stopped");api.signal?.throwIfAborted();options.signal?.throwIfAborted();
   if(action==="run-input"){const {runId,inputId,text}=input||{};digest(runId);if(typeof inputId!=="string"||inputId.length>200||typeof text!=="string"||text.length>24000)throw Error("Invalid team input");return {accepted:active.get(runId)?.runner?.provideInput(inputId,text)===true};}
   if(action==="run-stop"){stop(digest(input));return api.wallet.authorize(action,input,options.signal);}
   if(action==="stop"){for(const id of active.keys())stop(id);return api.wallet.authorize(action,input,options.signal);}
   if(action!=="run-execute")return api.wallet.authorize(action,input,options.signal);
   if(!input||Object.keys(input).sort().join()!=="body,kind,runId"||!["team","agents"].includes(input.kind))throw Error("Exact supported advanced run required");
   const id=digest(input.runId),body=input.body;
   if(active.has(id))throw Error("This run is already executing");
   const status=await api.wallet.authorize("run-status",id,options.signal),run=status.run;
   if(!run||run.id!==id||run.state!=="open"||run.mode!==input.kind||!body||!["koinos-network","koinos-network:"+run.model].includes(body.model))throw Error("Approved run mode, model, or state changed");
   if(!environment.gateway.dev.status().enabled)throw Error("Enable Developer tools first");
   const abort=new AbortController(),signal=AbortSignal.any([abort.signal,...[api.signal,options.signal].filter(Boolean)]),state={abort,runner:null,localId:null};active.set(id,state);events.set(id,[]);
   const guard=()=>signal.throwIfAborted();
   const tools={list:()=>registry.list(),call:async(name,args,opt)=>{guard();const result=await registry.call(name,args,{...opt,signal});guard();return result;}};
   const chatFn=async({messages,maxTokens})=>{guard();const reply=await api.wallet.authorize("run-chat",{runId:id,callId:crypto.randomBytes(32).toString("hex"),request:{model:"koinos-network:"+run.model,messages,max_tokens:Math.min(maxTokens||1200,run.maxOutput||1200),stream:false}},signal);guard();return reply.choices[0].message.content;};
   const onTrace=trace=>{if(trace.type==="start")state.localId=trace.runId;emit(id,trace);};
   const cancel=()=>{if(state.localId)state.runner?.stop(state.localId);};signal.addEventListener("abort",cancel,{once:true});
   try {guard();if(input.kind==="team"){if(Object.keys(body).some(k=>!["template","spec","question","model","allowSensitive"].includes(k)))throw Error("Invalid team run");state.runner=new TeamRunner({registry:tools,chatFn});return await state.runner.run({...body,allowSensitive:body.allowSensitive===true,onTrace});}
    if(Object.keys(body).some(k=>!["defId","spec","task","model","allowSensitive"].includes(k)))throw Error("Invalid agent run");const spec=body.spec??environment.gateway.agents.defs.get(body.defId)?.spec;if(!spec)throw Error("Choose a saved agent definition");state.runner=new GroupChatRunner({registry:tools,chatFn});return await state.runner.run({...body,spec,allowSensitive:body.allowSensitive===true,onTrace});
   }finally{signal.removeEventListener("abort",cancel);active.delete(id);}
  },
  dispose(){closed=true;for(const id of active.keys())stop(id);events.clear();}
 };
}
module.exports={createPaidRuns};
