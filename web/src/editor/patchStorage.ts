export interface LocalPatchVersion {
  id: string;
  savedAt: string;
}
export interface LocalPatchEntry {
  name: string;
  versionCount: number;
  versions: LocalPatchVersion[];
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function canUseLocalPatchStorage(): boolean {
  const viteEnv = (
    import.meta as ImportMeta & {
      env?: {
        DEV?: boolean;
        VITE_VISUAL_VISUAL_PATCH_STORAGE?: string;
      };
    }
  ).env;
  const storageMode = viteEnv?.VITE_VISUAL_VISUAL_PATCH_STORAGE;
  if (storageMode === "browser") return false;
  if (storageMode === "local") return true;
  return viteEnv?.DEV === true;
}

export async function fetchLocalPatchLibrary(): Promise<LocalPatchEntry[]> {
  const response = await fetch("/api/local-patches", {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(await localPatchStorageError(response));
  }

  const payload = (await response.json()) as unknown;
  if (!isRecord(payload) || !Array.isArray(payload.patches)) {
    throw new Error("Local patch library response was not valid.");
  }

  return payload.patches.flatMap((entry): LocalPatchEntry[] => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !Array.isArray(entry.versions)
    )
      return [];

    const versions = entry.versions.flatMap((version): LocalPatchVersion[] =>
      isRecord(version) &&
      typeof version.id === "string" &&
      typeof version.savedAt === "string"
        ? [{ id: version.id, savedAt: version.savedAt }]
        : [],
    );

    return [
      {
        name: entry.name,
        versionCount:
          typeof entry.versionCount === "number"
            ? entry.versionCount
            : versions.length,
        versions,
      },
    ];
  });
}

export function selectInitialLocalPatch(
  patches: LocalPatchEntry[],
  currentPatchName: string,
): LocalPatchEntry | null {
  const trimmedName = currentPatchName.trim();
  if (!trimmedName) return patches[0] ?? null;

  const storageName = sanitizeLocalPatchStorageSegment(trimmedName);
  const normalizedName = trimmedName.toLowerCase();
  const normalizedStorageName = storageName.toLowerCase();

  return (
    patches.find(
      (entry) =>
        entry.name === trimmedName ||
        entry.name === storageName ||
        entry.name.toLowerCase() === normalizedName ||
        entry.name.toLowerCase() === normalizedStorageName,
    ) ??
    patches[0] ??
    null
  );
}

function sanitizeLocalPatchStorageSegment(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");

  return cleaned || "untitled-patch";
}

export async function saveLocalPatchVersion(
  patchName: string,
  patchJson: string,
): Promise<void> {
  const response = await fetch("/api/local-patches", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: patchName, patchJson }),
  });

  if (!response.ok) {
    throw new Error(await localPatchStorageError(response));
  }
}

export async function fetchLocalPatchVersion(
  patchName: string,
  versionId: string,
): Promise<string> {
  const params = new URLSearchParams({
    patch: patchName,
    version: versionId,
  });
  const response = await fetch(
    `/api/local-patches/version?${params.toString()}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
    },
  );

  if (!response.ok) {
    throw new Error(await localPatchStorageError(response));
  }

  return response.text();
}

async function localPatchStorageError(response: Response): Promise<string> {
  const message = await response.text();
  return message || `Local patch storage failed with HTTP ${response.status}.`;
}
