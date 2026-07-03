import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    renderSyncPlugin(),
    ...(process.env.VITE_VISUAL_VISUAL_PATCH_STORAGE === 'browser' ? [] : [localPatchStoragePlugin()]),
  ],
  server: {
    https: viteHttpsConfig(),
    headers: crossOriginIsolationHeaders(),
  },
  preview: {
    https: viteHttpsConfig(),
    headers: crossOriginIsolationHeaders(),
  },
});

function crossOriginIsolationHeaders() {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  };
}

function viteHttpsConfig() {
  const keyPath = process.env.VISUAL_VISUAL_HTTPS_KEY;
  const certPath = process.env.VISUAL_VISUAL_HTTPS_CERT;
  if (!keyPath || !certPath || !existsSync(keyPath) || !existsSync(certPath)) return undefined;

  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  };
}

function renderSyncPlugin(): Plugin {
  const latestBundles = new Map<string, string>();
  const clientsByAppId = new Map<string, Set<Connect.ServerResponse>>();

  const sendBundle = (response: Connect.ServerResponse, bundle: string) => {
    response.write(`event: render-bundle\ndata: ${bundle}\n\n`);
  };

  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/api/render-bundle' && request.method === 'GET') {
      const appId = renderSyncAppId(url, response);
      if (!appId) return;

      const latestBundle = latestBundles.get(appId) ?? null;
      response.statusCode = latestBundle ? 200 : 204;
      response.setHeader('Cache-Control', 'no-store');
      if (latestBundle) {
        response.setHeader('Content-Type', 'application/json');
        response.end(latestBundle);
      } else {
        response.end();
      }
      return;
    }

    if (path === '/api/render-bundle' && request.method === 'POST') {
      readRequestBody(request).then((body) => {
        const appId = renderSyncAppId(url, response);
        if (!appId) return;

        latestBundles.set(appId, body);
        response.statusCode = 204;
        response.end();
        for (const client of clientsByAppId.get(appId) ?? []) {
          sendBundle(client, body);
        }
      }).catch((error: unknown) => {
        response.statusCode = 400;
        response.setHeader('Content-Type', 'text/plain');
        response.end(error instanceof Error ? error.message : String(error));
      });
      return;
    }

    if (path === '/api/render-events' && request.method === 'GET') {
      const appId = renderSyncAppId(url, response);
      if (!appId) return;

      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Connection', 'keep-alive');
      response.write('retry: 1000\n\n');
      const clients = clientsByAppId.get(appId) ?? new Set<Connect.ServerResponse>();
      clientsByAppId.set(appId, clients);
      clients.add(response);

      const latestBundle = latestBundles.get(appId);
      if (latestBundle) {
        sendBundle(response, latestBundle);
      }

      request.on('close', () => {
        clients.delete(response);
        if (clients.size === 0) {
          clientsByAppId.delete(appId);
        }
      });
      return;
    }

    next();
  };

  return {
    name: 'visual-visual-render-sync',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

function renderSyncAppId(url: URL, response: Connect.ServerResponse): string | null {
  const appId = url.searchParams.get('app-id');
  if (appId && /^[A-Za-z0-9]{5}$/.test(appId)) return appId;

  response.statusCode = 400;
  response.setHeader('Content-Type', 'text/plain');
  response.end('A valid 5-character app-id is required.');
  return null;
}

function localPatchStoragePlugin(): Plugin {
  const patchesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'patches');

  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (!path.startsWith('/api/local-patches')) {
      next();
      return;
    }

    if (path === '/api/local-patches' && request.method === 'GET') {
      listLocalPatches(patchesDir).then((patches) => {
        response.statusCode = 200;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ patches }));
      }).catch((error: unknown) => {
        sendPatchStorageError(response, error);
      });
      return;
    }

    if (path === '/api/local-patches' && request.method === 'POST') {
      readRequestBody(request).then(async (body) => {
        const payload = JSON.parse(body) as unknown;
        if (!isRecord(payload) || typeof payload.name !== 'string' || typeof payload.patchJson !== 'string') {
          throw new Error('Expected patch name and patch JSON.');
        }

        JSON.parse(payload.patchJson);
        const result = await saveLocalPatch(patchesDir, payload.name, payload.patchJson);
        response.statusCode = 201;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(result));
      }).catch((error: unknown) => {
        sendPatchStorageError(response, error);
      });
      return;
    }

    if (path === '/api/local-patches/version' && request.method === 'GET') {
      readLocalPatchVersion(patchesDir, url.searchParams.get('patch'), url.searchParams.get('version')).then((patchJson) => {
        response.statusCode = 200;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json');
        response.end(patchJson);
      }).catch((error: unknown) => {
        sendPatchStorageError(response, error);
      });
      return;
    }

    next();
  };

  return {
    name: 'visual-visual-local-patch-storage',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

interface LocalPatchVersion {
  id: string;
  savedAt: string;
}

interface LocalPatchEntry {
  name: string;
  versionCount: number;
  versions: LocalPatchVersion[];
}

async function listLocalPatches(patchesDir: string): Promise<LocalPatchEntry[]> {
  if (!existsSync(patchesDir)) return [];

  const entries = await readdir(patchesDir, { withFileTypes: true });
  const patches = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && isSafePatchStorageSegment(entry.name))
    .map(async (entry): Promise<LocalPatchEntry | null> => {
      const patchDir = join(patchesDir, entry.name);
      const files = await readdir(patchDir, { withFileTypes: true });
      const versions = await Promise.all(files
        .filter((file) => file.isFile() && file.name.endsWith('.json') && isSafePatchVersionFilename(file.name))
        .map(async (file): Promise<LocalPatchVersion> => {
          const fileStats = await stat(join(patchDir, file.name));
          return {
            id: file.name.slice(0, -'.json'.length),
            savedAt: fileStats.mtime.toISOString(),
          };
        }));

      versions.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
      if (versions.length === 0) return null;

      return {
        name: entry.name,
        versionCount: versions.length,
        versions,
      };
    }));

  return patches
    .filter((entry): entry is LocalPatchEntry => entry !== null)
    .sort((a, b) => {
      const latestA = a.versions[0]?.savedAt ?? '';
      const latestB = b.versions[0]?.savedAt ?? '';
      return latestB.localeCompare(latestA) || a.name.localeCompare(b.name);
    });
}

async function saveLocalPatch(patchesDir: string, requestedName: string, patchJson: string) {
  const patchName = sanitizePatchStorageSegment(requestedName);
  const patchDir = join(patchesDir, patchName);
  await mkdir(patchDir, { recursive: true });

  const savedAt = new Date();
  const versionId = savedAt.toISOString().replace(/:/g, '-');
  let filePath = join(patchDir, `${versionId}.json`);
  let suffix = 2;
  while (existsSync(filePath)) {
    filePath = join(patchDir, `${versionId}-${suffix}.json`);
    suffix += 1;
  }

  await writeFile(filePath, patchJson, 'utf8');

  return {
    patchName,
    version: {
      id: filePath.slice(patchDir.length + 1, -'.json'.length),
      savedAt: savedAt.toISOString(),
    },
  };
}

async function readLocalPatchVersion(patchesDir: string, patchName: string | null, versionId: string | null): Promise<string> {
  if (!patchName || !versionId || !isSafePatchStorageSegment(patchName) || !isSafePatchStorageSegment(versionId)) {
    throw new Error('Invalid patch version.');
  }

  return readFile(join(patchesDir, patchName, `${versionId}.json`), 'utf8');
}

function sanitizePatchStorageSegment(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');

  return cleaned || 'untitled-patch';
}

function isSafePatchStorageSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !/[\u0000-\u001f]/.test(value)
  );
}

function isSafePatchVersionFilename(value: string): boolean {
  return /^[0-9TZ_.-]+\.json$/.test(value);
}

function sendPatchStorageError(response: Connect.ServerResponse, error: unknown): void {
  response.statusCode = 400;
  response.setHeader('Content-Type', 'text/plain');
  response.end(error instanceof Error ? error.message : String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequestBody(request: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}
