const DB = "visual-visual.assets";
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function storeAsset(file: File): Promise<string> {
  const db = await database(),
    id = `asset:${crypto.randomUUID()}/${encodeURIComponent(file.name)}`;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").put(file, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return id;
  } finally {
    db.close();
  }
}
export async function resolveAsset(
  reference: string,
): Promise<{ url: string; release(): void }> {
  if (!reference.startsWith("asset:")) return { url: reference, release() {} };
  const db = await database();
  try {
    const file = await new Promise<Blob | undefined>((resolve, reject) => {
      const request = db
        .transaction("files")
        .objectStore("files")
        .get(reference);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!file)
      throw new Error(
        `Missing local asset ${decodeURIComponent(reference.split("/").at(-1)!)}. Choose the file again in its node.`,
      );
    const url = URL.createObjectURL(file);
    return { url, release: () => URL.revokeObjectURL(url) };
  } finally {
    db.close();
  }
}
