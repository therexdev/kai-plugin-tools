"use strict";
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
module.exports=function fixture(name,options={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"kai-foundation-test-")),dataDir=path.join(root,"profile","plugins",name);fs.mkdirSync(dataDir,{recursive:true});
 const memory={},reviews=[],events=[],services=new Map(),controller=new AbortController();
 const api={version:1,plugin:{id:"kai."+name,version:"0.3.0",dataDir,root},signal:controller.signal,settings:{get:(key,fallback)=>structuredClone(memory[key]??fallback),set:(key,value)=>memory[key]=structuredClone(value)},
  models:{list:()=>[{alias:"local",label:"Local model",status:"ready"}],chat:options.chat|| (async()=>({choices:[{message:{content:"Answer"}}]})),request:options.request},
  runtime:{status:()=>({activeAlias:"local"})},network:{status:()=>({privacyMode:options.mode||"local-only"})},
  secrets:{isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from("sealed:"+text),decryptString:buffer=>{const s=buffer.toString();if(!s.startsWith("sealed:"))throw Error("Bad secret");return s.slice(7);}},
  desktop:{confirm:async(title,detail)=>{reviews.push({title,detail});return options.approve!==false;},send:(channel,value)=>events.push({channel,value}),isVisible:()=>true},
  services:{provide:(name,service)=>{services.set(name,service);return ()=>services.delete(name);},call:options.serviceCall|| (async()=>{throw Error("Service not installed");})},
  wallet:{authorize:options.authorize||(async()=>{throw Error("No test payment configured");})},log:()=>{}};
 return {api,root,dataDir,memory,reviews,events,services,controller,request:(service,p,body,method=body===undefined?"GET":"POST")=>service.call(name==="code"?"code.request":name==="tools"?"tools.ui.request":"compare.request",{path:p,method,body,requestId:crypto.randomUUID()}),cleanup(){fs.rmSync(root,{recursive:true,force:true});}};
};
module.exports.drain=async function(service,prefix,streamId,onFrame){let text="";for(let i=0;i<500;i++){const r=await service.call(prefix+".poll",{streamId});for(const part of r.chunks||[]){text+=part;if(onFrame)for(const line of part.split("\n")){if(line.startsWith("data: "))await onFrame(JSON.parse(line.slice(6)));}}if(r.error)throw Error(r.error);if(r.done)return text;await new Promise(r=>setTimeout(r,2));}throw Error("Stream did not complete");};
