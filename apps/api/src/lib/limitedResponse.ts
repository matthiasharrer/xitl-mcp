// Bounds how much of an upstream's HTTP response xitl will read (TC-48). The
// upstream is untrusted: a 50 MB tools/list or an endless stream must fail the
// request, not fill memory. Used by the MCP fetch wrapper
// (upstream/connection.ts) and the OAuth fetch (upstream/oauthClient.ts).

export class ResponseTooLarge extends Error {
  override name = 'ResponseTooLarge';
}

/**
 * Returns a Response whose body errors with ResponseTooLarge once more than
 * `maxBytes` have been read. A declared Content-Length over the limit is
 * refused before reading anything. The result is built with the CURRENT global
 * `Response` (see oauthClient.ts on why that matters with @hono/node-server).
 */
export async function limitResponse(res: Response, maxBytes: number): Promise<Response> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLarge(`response declares ${declared} bytes`);
  }
  const init = { status: res.status, statusText: res.statusText, headers: res.headers };
  if (!res.body) return new Response(null, init);
  let seen = 0;
  const limited = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(new ResponseTooLarge(`response over ${maxBytes} bytes`));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(limited, init);
}
