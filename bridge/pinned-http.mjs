import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export function createPinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    const family = Number(options.family || 0);
    const matches = addresses.filter(item => !family || item.family === family);
    if (!matches.length) { callback(new Error("No validated address for requested family")); return; }
    if (options.all) callback(null, matches.map(item => ({ ...item })));
    else callback(null, matches[0].address, matches[0].family);
  };
}

function decodeResponseBody(source, headers) {
  const decoders = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress };
  const factory = decoders[(headers.get("content-encoding") || "").toLowerCase()];
  if (!factory) return source;
  const decoder = factory();
  pipeline(source, decoder, () => {});
  headers.delete("content-encoding");
  headers.delete("content-length");
  return decoder;
}

// Preserve the URL hostname for Host/SNI/certificate verification; only DNS resolution is pinned.
export function fetchPinnedResponse(url, { addresses, method, headers, signal, requestImpl } = {}) {
  const request = requestImpl || (url.protocol === "https:" ? httpsRequest : httpRequest);
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method, headers: Object.fromEntries(new globalThis.Headers(headers)), signal,
      agent: false, lookup: createPinnedLookup(addresses),
    }, incoming => {
      try {
        const responseHeaders = new globalThis.Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        }
        const noBody = method === "HEAD" || [204, 205, 304].includes(incoming.statusCode);
        const stream = noBody ? null : decodeResponseBody(incoming, responseHeaders);
        if (noBody) incoming.resume();
        const body = stream && Readable.toWeb(stream, { strategy: { highWaterMark: 65536, size: chunk => chunk.length } });
        resolve(new globalThis.Response(body, { status: incoming.statusCode, headers: responseHeaders }));
      } catch (error) { incoming.destroy(); reject(error); }
    });
    req.once("error", reject);
    req.end();
  });
}
