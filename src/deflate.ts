/**
 * Raw DEFLATE (no zlib/gzip wrapper) through the runtime's own Compression Streams — present in
 * WebView2 and in Node 22, so no library is bundled. DAVE archives and ZIP members both store raw
 * DEFLATE (the reference script decompresses DAVE entries with `zlib.decompress(raw, -15)`).
 */

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const input = new Blob([bytes as BlobPart]).stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(input).arrayBuffer());
}

export const inflateRaw = (bytes: Uint8Array) => pipe(bytes, new DecompressionStream("deflate-raw"));
export const deflateRaw = (bytes: Uint8Array) => pipe(bytes, new CompressionStream("deflate-raw"));
