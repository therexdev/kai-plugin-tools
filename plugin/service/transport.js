"use strict";
const {Readable,Writable}=require("node:stream");
const {randomUUID}=require("node:crypto");
const {AsyncLocalStorage}=require("node:async_hooks");
const {StringDecoder}=require("node:string_decoder");
const execution=new AsyncLocalStorage();
// Plugin-owned transport: no TCP listener, shared gateway or Core route access.
function createTransport({route,signal,onStop=()=>{}}) {
 const streams=new Map(),requests=new Map();let closed=false;
 function active(other) {if(closed)throw Error("Plugin service is stopped");signal?.throwIfAborted();other?.throwIfAborted();}
 function stop(record,reason="Operation stopped") {if(record.done)return;record.done=true;record.error=reason;record.controller.abort(Error(reason));try{onStop(record);}catch{}record.res.destroy();record.req.destroy();record.ready();record.finish();}
 function cleanup(record) {clearInterval(record.timer);record.combined.removeEventListener("abort",record.abort);streams.delete(record.id);requests.delete(record.requestId);}
 return {
  execution,
  async request(input={},outerSignal) {
   active(outerSignal);
   const url=new URL(String(input.path||""),"http://plugin.invalid");
   if(url.origin!=="http://plugin.invalid"||!url.pathname.startsWith("/core/")||url.username||url.password||url.hash)throw Error("Unsupported plugin request");
   const method=String(input.method||"GET").toUpperCase();if(!["GET","POST","PATCH","DELETE"].includes(method))throw Error("Unsupported request method");
   const requestId=input.requestId||randomUUID();if(typeof requestId!=="string"||requestId.length>100||requests.has(requestId))throw Error("Invalid or duplicate request");
   if(streams.size>=16)throw Error("Finish another request first");
   const body=input.body===undefined?Buffer.alloc(0):Buffer.from(typeof input.body==="string"?input.body:JSON.stringify(input.body));
   if(body.length>4*1024*1024||method==="GET"&&body.length)throw Error("Invalid request body");
   const controller=new AbortController(),combined=AbortSignal.any([controller.signal,...[signal,outerSignal].filter(Boolean)]);
   const record={id:randomUUID(),requestId,controller,combined,chunks:[],bytes:0,done:false,error:null,runs:new Set(),decoder:new StringDecoder("utf8"),lastPoll:Date.now()};
   let ready,finish;const opened=new Promise(r=>ready=r),ended=new Promise(r=>finish=r);record.ready=ready;record.finish=finish;
   const headers={},res=new Writable({autoDestroy:false,write(chunk,encoding,cb){if(record.done)return cb();const bytes=Buffer.from(chunk);record.bytes+=bytes.length;if(record.bytes>8*1024*1024){stop(record,"Response buffer is full");return cb();}record.chunks.push(bytes);ready();cb();},final(cb){record.done=true;ready();finish();cb();}});
   Object.assign(res,{statusCode:200,headersSent:false,setHeader(key,value){headers[String(key).toLowerCase()]=String(value);return res;},getHeader:key=>headers[String(key).toLowerCase()],writeHead(status,values={}){res.statusCode=status;for(const [k,v]of Object.entries(values))res.setHeader(k,v);res.headersSent=true;ready();return res;},flushHeaders(){res.headersSent=true;ready();}});
   const req=Readable.from(body.length?[body]:[]);Object.assign(req,{url:url.pathname+url.search,method,headers:{"content-type":"application/json"},socket:{remoteAddress:"127.0.0.1"}});
   record.req=req;record.res=res;requests.set(requestId,record);streams.set(record.id,record);
   record.abort=()=>stop(record);combined.addEventListener("abort",record.abort,{once:true});
   record.timer=setInterval(()=>{if(Date.now()-record.lastPoll>120000){stop(record,"Request expired because the client stopped reading");cleanup(record);}},30000);record.timer.unref?.();
   res.on("error",error=>stop(record,error.message));req.on("error",()=>{});
   record.task=Promise.resolve().then(()=>execution.run({signal:combined,record},()=>{combined.throwIfAborted();return route(req,res);})).catch(error=>{record.error=error.message;if(!res.destroyed&&!res.writableEnded){if(!res.headersSent)res.writeHead(400,{"content-type":"application/json"});res.end(JSON.stringify({ok:false,error:error.message}));}else {record.done=true;ready();finish();}});
   if(combined.aborted)record.abort();await opened;active(outerSignal);
   const result={ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,headers};
   if(String(headers["content-type"]||"").includes("text/event-stream"))return {...result,streamId:record.id};
   await ended;cleanup(record);active(outerSignal);const text=Buffer.concat(record.chunks).toString("utf8");let value=text;try{value=JSON.parse(text);}catch{}return {...result,body:value};
  },
  poll(input,outerSignal) {active(outerSignal);const record=streams.get(typeof input==="string"?input:input?.streamId);if(!record)throw Error("Unknown plugin stream");const chunks=[];let size=0;while(record.chunks.length&&size<256*1024){const b=record.chunks.shift();record.bytes-=b.length;size+=b.length;chunks.push(record.decoder.write(b));}record.lastPoll=Date.now();const done=record.done&&!record.chunks.length;if(done){const tail=record.decoder.end();if(tail)chunks.push(tail);cleanup(record);}return {chunks,done,...(record.error?{error:record.error}:{})};},
  cancel(input) {const record=typeof input==="string"?streams.get(input):input?.streamId?streams.get(input.streamId):requests.get(input?.requestId);if(record){stop(record);cleanup(record);}return {stopped:true};},
  async dispose() {closed=true;const pending=[...streams.values()];for(const record of pending){stop(record,"Plugin stopped");cleanup(record);}await Promise.allSettled(pending.map(record=>record.task));}
 };
}
async function forwardResponse(response,res,signal) {
 res.writeHead(response.status,Object.fromEntries(response.headers));if(!response.body)return res.end();
 const reader=response.body.getReader(),abort=()=>{void reader.cancel(signal.reason).catch(()=>{});};signal?.addEventListener("abort",abort,{once:true});
 try{signal?.throwIfAborted();while(true){const {done,value}=await reader.read();signal?.throwIfAborted();if(done||res.destroyed)break;res.write(Buffer.from(value));}if(!res.destroyed)res.end();}
 finally{signal?.removeEventListener("abort",abort);reader.releaseLock();}
}
module.exports={createTransport,execution,forwardResponse};
