"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const read = name => fs.readFileSync(path.join(__dirname, "../plugin", name), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const elements = new Map(), created = [], listeners = new Map(), calls = [], reviews = [];
  function element(id = "") {
    const handlers = new Map();
    return { id, value: "", textContent: "", innerHTML: "", hidden: true, disabled: false, open: false, returnValue: "", checked: false, dataset: {}, style: {}, children: [],
      addEventListener(name, fn, options) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push({fn, once:options?.once}); },
      async fire(name, event = {}) { for (const row of [...(handlers.get(name) || [])]) { if (row.once) handlers.set(name, handlers.get(name).filter(v => v !== row)); await row.fn(event); } },
      appendChild(child) { this.children.push(child); return child; }, append(...children) { this.children.push(...children); }, after() {}, remove() {}, focus() {}, setAttribute() {},
      querySelector(selector) { return get(id + ":" + selector); }, querySelectorAll() { return []; }, contains() { return false; },
      showModal() { this.open = true; }, close(value) { if (value !== undefined) this.returnValue = value; this.open = false; void this.fire("close"); },
      classList: { add() {}, remove() {}, toggle() {} },
    };
  }
  function get(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); }
  const document = { getElementById:get, createElement(tag) { const item=element(tag); created.push(item); return item; }, createTextNode:text=>({textContent:text}), querySelectorAll:()=>[], addEventListener() {}, body:element("body"), activeElement:null };
  let resolveReview;
  const window = { addEventListener(name, fn) { listeners.set(name, fn); }, kai: { dialogs: { confirm(message) { reviews.push(message); return new Promise(resolve => { resolveReview=resolve; }); }, alert:async()=>{} } } };
  const fetch = async (url, options={}) => { calls.push({url, options}); return {ok:true, json:async()=>({ok:true,server:{id:"server1"}})}; };
  const context = vm.createContext({window,document,fetch,MutationObserver:class{observe(){}},clearInterval(){},setInterval(){},setTimeout(){},clearTimeout(){},URL,TextDecoder,TextEncoder,Uint8Array,ReadableStream,Response,console,crypto:require("node:crypto").webcrypto, $:get,state:{alias:"local"},coreGet:async()=>({}),composedChatModel:()=>"local",KaiI18n:{html:(s,...v)=>String.raw({raw:s},...v),message:(s,...v)=>String.raw({raw:s},...v),setText:(el,text)=>{el.textContent=text;}}});
  return {window, document, elements, created, calls, reviews, context, get, resolveReview:value=>resolveReview(value), listeners};
}

test("a local tool server is not added while review is pending or after Cancel", async () => {
  const f=fixture(); vm.runInContext(read("tools-view.js"),f.context);
  f.get("mcp-cmd").value="node server.js";
  const pending=f.get("mcp-add-custom").fire("click"); await flush();
  assert.equal(f.reviews.length,1); assert.equal(f.calls.length,0);
  f.resolveReview(false); await pending; assert.equal(f.calls.length,0);
  const allowed=f.get("mcp-add-custom").fire("click"); await flush(); f.resolveReview(true); await allowed;
  assert.equal(f.calls[0].url,"/core/mcp"); assert.equal(JSON.parse(f.calls[0].options.body).command,"node server.js");
});

test("sensitive team flags await an actual dialog decision before dispatch", async () => {
  for (const [button,input,task,route,bodyKey] of [["btn-dev-run","dev-spec","dev-question","/core/teams/run",null],["btn-pg-run","ag-json","pg-task","/core/agents/run","agents"]]) {
    const f=fixture(); vm.runInContext(read("devtools-view.js"),f.context);
    f.get(input).value=JSON.stringify(bodyKey?{agents:[{tools:["run_code"]}]}:{tools:["run_code"]}); f.get(task).value="Review this task";
    const pending=f.get(button).fire("click"); await flush(); assert.equal(f.calls.length,0); assert.equal(f.reviews.length,1);
    f.resolveReview(false); await pending;
    const request=f.calls.find(c=>c.url===route); assert.ok(request); assert.equal(JSON.parse(request.options.body).allowSensitive,false);
  }
});

test("a reused budget dialog cancels with Escape or X without inheriting an earlier approval", async () => {
  const f=fixture(); const actions=[];
  f.window.kaiKoinTestBridge={run:async(action,input)=>{actions.push({action,input}); return {run:{id:"a".repeat(64)}};},onProgress:()=>()=>{}};
  f.window.KaiNetwork={refresh:async()=>({product:"prepaid-usd-v1",activation:"ready",runBudgets:true}),selectedModel:()=>null};
  vm.runInContext(read("credit-runs.js"),f.context); const dialog=f.created.find(e=>e.id==="credit-run-review");
  f.get("credit-run-budget").value="5";
  const first=f.window.KaiCreditRuns.begin("team"); await flush(); dialog.close("start"); assert.equal(await first,true); await f.window.KaiCreditRuns.finish();
  const second=f.window.KaiCreditRuns.begin("team"); await flush(); assert.equal(dialog.returnValue,"");
  let prevented=false; await dialog.fire("cancel",{preventDefault(){prevented=true;}}); assert.equal(await second,false); assert.equal(prevented,true);
  const third=f.window.KaiCreditRuns.begin("team"); await flush(); await f.get("credit-run-close").fire("click"); assert.equal(await third,false);
  assert.equal(actions.filter(a=>a.action==="run-open").length,1);
});
