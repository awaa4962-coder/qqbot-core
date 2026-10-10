import { TransformStream } from "node:stream/web";
import { MCP_LIMITS, safeEndpoint, reject } from "./policy.mjs";

export function createMcpFetch(endpoint, { token = "", signal, fetchImpl = globalThis.fetch,
  onNotificationFailure = () => {} } = {}) {
  const url = safeEndpoint(endpoint);
  return async (input, init = {}) => {
    const target = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (safeEndpoint(target) !== url) reject("endpoint_changed");
    const notification = init.method === "GET";
    const headersDeadline = new AbortController();
    const timer = notification ? setTimeout(() => headersDeadline.abort(), MCP_LIMITS.timeoutMs) : null;
    const operation = globalThis.AbortSignal.any([signal, init.signal,
      notification ? headersDeadline.signal : globalThis.AbortSignal.timeout(MCP_LIMITS.timeoutMs)].filter(Boolean));
    const headers = new globalThis.Headers(init.headers);
    // Static credentials only. No OAuth flow, credential discovery or error replay.
    if (token) headers.set("Authorization", "Bearer " + token);
    let response;
    try { response = await fetchImpl(url, { ...init, headers, redirect: "error", signal: operation }); }
    catch (error) {
      if (notification && !signal?.aborted && !init.signal?.aborted) onNotificationFailure("notification_stream_failed");
      throw error;
    } finally { if (timer) clearTimeout(timer); }
    return boundResponse(response, { notification, signal, initSignal: init.signal, onNotificationFailure });
  };
}

async function boundResponse(response, { notification, signal, initSignal, onNotificationFailure }) {
  if (response.status >= 300 && response.status < 400) reject("redirect_denied");
  if ((!notification || !response.ok) && Number(response.headers.get("content-length")) > MCP_LIMITS.wireBytes) {
    await response.body?.cancel(); reject("wire_limit");
  }
  if (!response.body) {
    if (notification && response.ok) { onNotificationFailure("notification_stream_invalid"); reject("notification_stream_invalid"); }
    return response;
  }
  if (notification && response.ok && !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    await response.body.cancel(); onNotificationFailure("notification_stream_invalid"); reject("notification_stream_invalid");
  }
  let bytes = 0;
  const countFrame = notification ? createFrameCounter() : null;
  const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
    if (countFrame) {
      try { countFrame(chunk); }
      catch (error) { onNotificationFailure("notification_stream_limit"); throw error; }
    } else {
      bytes += chunk.byteLength;
      if (bytes > MCP_LIMITS.wireBytes) reject("wire_limit");
    }
    controller.enqueue(chunk);
  }, flush() {
    if (notification && response.ok && !signal?.aborted && !initSignal?.aborted) onNotificationFailure("notification_stream_ended");
  } }));
  return new globalThis.Response(body, { status: response.status, statusText: "", headers: response.headers });
}

// Bound each SSE frame, not the aggregate lifetime of a notification channel.
function createFrameCounter() {
  let bytes = 0; let hasData = false; let cr = false;
  return chunk => {
    for (const byte of chunk) {
      if (++bytes > MCP_LIMITS.wireBytes) reject("wire_limit");
      if (byte === 10 && cr) { cr = false; continue; }
      if (byte === 10 || byte === 13) {
        if (!hasData) bytes = 0;
        hasData = false; cr = byte === 13;
      } else { hasData = true; cr = false; }
    }
  };
}

export async function createHttpMcpClient(server, { token, signal, fetchImpl } = {}) {
  const { Client, StreamableHTTPClientTransport, fromJsonSchema } =
    await import("@modelcontextprotocol/client");
  let intentionalClose = false; let invalidReason = ""; let onInvalidated;
  const invalidate = reason => {
    if (intentionalClose || invalidReason) return;
    invalidReason = reason; onInvalidated?.(reason);
  };
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    fetch: createMcpFetch(server.url, { token, signal, fetchImpl, onNotificationFailure: invalidate }), requestInit: { redirect: "error" },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    onInsufficientScope: "throw", maxStepUpRetries: 0,
  });
  const client = new Client({ name: "qqfriend-linux-readonly", version: "1" }, {
    capabilities: {}, listMaxPages: MCP_LIMITS.pages, enforceStrictCapabilities: true,
  });
  client.onerror = () => invalidate("transport_error");
  client.onclose = () => invalidate("transport_closed");
  const validators = new Map();
  return {
    connect: options => client.connect(transport, options),
    listTools: (params, options) => client.listTools(params, options),
    callTool: (params, options) => client.callTool(params, options),
    onToolsChanged: callback => client.setNotificationHandler("notifications/tools/list_changed", callback),
    onTransportInvalidated(callback) { onInvalidated = callback; if (invalidReason) callback(invalidReason); },
    validate(schema, args) {
      const key = JSON.stringify(schema);
      if (!validators.has(key)) validators.set(key, fromJsonSchema(schema));
      return validators.get(key)["~standard"].validate(args);
    },
    async close() { intentionalClose = true; try { await transport.terminateSession(); } finally { await client.close(); } },
    abort() { intentionalClose = true; return client.close(); },
  };
}
