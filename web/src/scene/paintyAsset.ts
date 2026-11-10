import { resolveAsset } from "./assets";
import { MAX_PAINTY_FILE_BYTES, readPaintyFile } from "./painty";

export async function loadPaintyAsset(reference: string, signal: AbortSignal) {
  const asset = await resolveAsset(reference);
  try {
    signal.throwIfAborted();
    const response = await fetch(asset.url, { signal });
    if (!response.ok)
      throw new Error(`Could not load Painty file (HTTP ${response.status}).`);
    if (Number(response.headers.get("content-length")) > MAX_PAINTY_FILE_BYTES)
      throw new Error("Painty file exceeds 140 MiB.");
    const document = await readPaintyFile(await response.blob());
    signal.throwIfAborted();
    return document;
  } finally {
    asset.release();
  }
}
