"use strict";
window.fetch=window.KaiLegacyFetch("tools.ui");
const $ = id => document.getElementById(id);
const state = { alias: null };
async function coreGet(route) {
  const response = await fetch(route), value = await response.json();
  if (!response.ok || value.ok === false) throw Error(value.error?.message || value.error || "The service could not finish this request");
  return value;
}
function composedChatModel() { return $("model-pick").value; }
window.kaiKoinTestBridge = Object.freeze({
  run: (action, input) => window.kai.call("tools.payment", { action, input }),
  onProgress: callback => window.kai.onEvent("koin:chat-progress", callback),
});
