"use strict";

// A feature owns its requests and streams. Cancellation never addresses another
// plugin's request, and the native runtime independently validates every route.
function createFeatureRequests(ctx, feature, authorize = async () => {}) {
  const requests = new Map(), streams = new Map(); let closed = false;
  const check = signal => { if (closed) throw Error("Feature is closing"); signal?.throwIfAborted(); };
  return {
    async request(input, signal) {
      check(signal);
      if (!input || typeof input.requestId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(input.requestId) || requests.has(input.requestId)) throw Error("Invalid or duplicate request");
      const controller = new AbortController(), combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
      const entry = { controller, streamId: null }; requests.set(input.requestId, entry);
      try {
        await authorize(input, combined); check(combined);
        const result = await ctx.request(feature, input, combined);
        check(combined);
        if (result.streamId) { entry.streamId = result.streamId; streams.set(result.streamId, input.requestId); }
        else requests.delete(input.requestId);
        return result;
      } catch (error) { requests.delete(input.requestId); throw error; }
    },
    async poll(input, signal) {
      check(signal); const requestId = streams.get(input?.streamId);
      if (!requestId) throw Error("Unknown feature stream");
      const result = await ctx.poll(feature, input.streamId, signal);
      if (result.done) { requests.delete(requestId); streams.delete(input.streamId); }
      return result;
    },
    async cancel(input) {
      const entry = requests.get(input?.requestId); if (!entry) return { stopped: true };
      entry.controller.abort();
      if (entry.streamId) { try { await ctx.cancel(feature, entry.streamId); } catch { /* Signal may already have closed the stream. */ } streams.delete(entry.streamId); }
      requests.delete(input.requestId); return { stopped: true };
    },
    async dispose() {
      closed = true; for (const entry of requests.values()) entry.controller.abort();
      await Promise.allSettled([...streams.keys()].map(id => ctx.cancel(feature, id)));
      requests.clear(); streams.clear(); await ctx.release?.(feature);
    },
  };
}
module.exports = { createFeatureRequests };
