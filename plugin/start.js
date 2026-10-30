"use strict";
(() => {
  let view = "tools", refreshing = false, enabled = false;
  const notice = error => { $("tools-developer-error").hidden = !error; $("tools-developer-error").textContent = error?.message || String(error || ""); };
  async function renderModels() {
    if (refreshing) return; refreshing = true;
    try {
      const previous = $("model-pick").value, models = await coreGet("/core/models");
      const local = models.aliases.filter(model => model.status === "ready");
      if (!local.some(model => model.alias === state.alias)) state.alias = local.find(model => model.alias === models.runtime?.activeAlias)?.alias || local[0]?.alias || null;
      let choices = local.map(model => ({ id: model.alias, label: model.label || model.alias }));
      if ($("src-pick").value === "network") {
        const info = await KaiNetwork.refresh();
        choices = (info.models || []).map(model => ({ id: "koinos-network:" + model.model, label: model.label || model.model, disabled: !model.available || !!info.blocked }));
      }
      $("model-pick").replaceChildren();
      for (const choice of choices) { const option = document.createElement("option"); option.value = choice.id; option.textContent = choice.label; option.disabled = choice.disabled === true; $("model-pick").append(option); }
      if (choices.some(choice => choice.id === previous)) $("model-pick").value = previous;
      else if ($("src-pick").value === "local" && state.alias) $("model-pick").value = state.alias;
      if (!choices.length) { const option = document.createElement("option"); option.value = ""; option.textContent = $("src-pick").value === "network" ? "No available network models" : "Install a model in Core first"; $("model-pick").append(option); }
      if ($("src-pick").value === "local") state.alias = $("model-pick").value || null;
      $("model-pick").dispatchEvent(new Event("change"));
    } catch (error) { notice(error); }
    finally { refreshing = false; }
  }
  async function status() {
    const result = await coreGet("/core/dev"); enabled = result.enabled === true;
    $("btn-dev-toggle").setAttribute("aria-checked", String(enabled)); $("nav-devtools").hidden = !enabled;
    return enabled;
  }
  async function show(next) {
    try {
      await status();
      view = next === "devtools" && !enabled ? "tools" : next;
      for (const section of document.querySelectorAll("main > .view")) section.hidden = section.id !== "view-" + view;
      for (const button of document.querySelectorAll("[data-tools-view]")) button.classList.toggle("active", button.dataset.toolsView === view);
      if (view === "devtools") { await renderModels(); await KaiDevTools.render(); }
      if (next === "devtools" && !enabled) { $("btn-dev-toggle").focus(); notice("Enable Developer tools to open the builders and benchmark."); }
    } catch (error) { notice(error); }
  }
  $("btn-dev-toggle").addEventListener("click", async () => {
    const button = $("btn-dev-toggle"); button.disabled = true; notice("");
    try { const response = await fetch("/core/dev", { method: "POST", body: JSON.stringify({ enabled: !enabled }) }); const value = await response.json(); if (!response.ok || !value.ok) throw Error(value.error || "Developer tools could not change"); await show(value.enabled ? "devtools" : "tools"); }
    catch (error) { notice(error); } finally { button.disabled = false; }
  });
  for (const button of document.querySelectorAll("[data-tools-view]")) button.addEventListener("click", () => show(button.dataset.toolsView));
  $("src-pick").addEventListener("change", () => renderModels());
  $("model-pick").addEventListener("change", () => { if ($("src-pick").value === "local") state.alias = $("model-pick").value || null; });
  const results = document.createElement("button"); results.className = "subtab"; results.textContent = "Research & agent results"; results.addEventListener("click", () => show("recovery")); document.querySelector(".tools-navigation").append(results);
  window.kai.onEvent("kai-plugin:navigate", value => { if (value?.section === "devtools") void show("devtools"); });
  window.addEventListener("unhandledrejection", event => { event.preventDefault(); const target = view === "devtools" ? $("dev-error") : $("tools-developer-error"); target.hidden = false; target.textContent = event.reason?.message || String(event.reason); });
  void show("tools");
})();
