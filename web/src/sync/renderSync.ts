import { useEffect, useState } from 'react';
import { isRenderBundle, type RenderBundle } from '../render/renderBundle';

const RENDER_BUNDLE_ENDPOINT = '/api/render-bundle';
const RENDER_EVENTS_ENDPOINT = '/api/render-events';
const RENDER_SYNC_APP_ID_PARAM = 'app-id';
const RENDER_SYNC_APP_ID_LENGTH = 5;
const RENDER_SYNC_APP_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const RENDER_SYNC_APP_ID_PATTERN = /^[A-Za-z0-9]{5}$/;

export function useRenderSyncPublisher(bundle: RenderBundle | null, appId: string | null): void {
  useEffect(() => {
    if (!bundle || !appId) return;

    const abortController = new AbortController();
    void fetch(renderSyncUrl(RENDER_BUNDLE_ENDPOINT, appId), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bundle),
      signal: abortController.signal,
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.warn('Could not publish render bundle.', error);
    });

    return () => {
      abortController.abort();
    };
  }, [appId, bundle]);
}

export function useRenderSyncReceiver(appId: string | null): RenderBundle | null {
  const [bundle, setBundle] = useState<RenderBundle | null>(null);

  useEffect(() => {
    setBundle(null);
    if (!appId) return;

    let disposed = false;

    void fetch(renderSyncUrl(RENDER_BUNDLE_ENDPOINT, appId))
      .then(async (response) => {
        if (response.status === 204) return null;
        if (!response.ok) {
          throw new Error(`Render bundle request failed: ${response.status}`);
        }
        return await response.json() as unknown;
      })
      .then((payload) => {
        if (!disposed && isRenderBundle(payload)) {
          setBundle(payload);
        }
      })
      .catch((error: unknown) => {
        console.warn('Could not load latest render bundle.', error);
      });

    const events = new EventSource(renderSyncUrl(RENDER_EVENTS_ENDPOINT, appId));
    events.addEventListener('render-bundle', (event) => {
      try {
        const payload = JSON.parse(event.data) as unknown;
        if (!disposed && isRenderBundle(payload)) {
          setBundle(payload);
        }
      } catch (error) {
        console.warn('Could not parse render bundle event.', error);
      }
    });
    events.onerror = () => {
      console.warn('Render sync connection interrupted.');
    };

    return () => {
      disposed = true;
      events.close();
    };
  }, [appId]);

  return bundle;
}

export function ensureRenderSyncAppIdInUrl(): string {
  const currentAppId = readRenderSyncAppIdFromUrl();
  if (currentAppId) return currentAppId;

  const nextAppId = generateRenderSyncAppId();
  writeRenderSyncAppIdToUrl(nextAppId);
  return nextAppId;
}

export function readRenderSyncAppIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const appId = params.get(RENDER_SYNC_APP_ID_PARAM);
  return isRenderSyncAppId(appId) ? appId : null;
}

export function writeRenderSyncAppIdToUrl(appId: string): void {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set(RENDER_SYNC_APP_ID_PARAM, appId);
  window.history.replaceState(window.history.state, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
}

export function isRenderSyncAppId(value: string | null): value is string {
  return typeof value === 'string' && RENDER_SYNC_APP_ID_PATTERN.test(value);
}

export function renderSyncAppIdLength(): number {
  return RENDER_SYNC_APP_ID_LENGTH;
}

function generateRenderSyncAppId(): string {
  const values = new Uint32Array(RENDER_SYNC_APP_ID_LENGTH);
  window.crypto.getRandomValues(values);

  return Array.from(values, (value) => RENDER_SYNC_APP_ID_ALPHABET[value % RENDER_SYNC_APP_ID_ALPHABET.length]).join('');
}

function renderSyncUrl(path: string, appId: string): string {
  const params = new URLSearchParams({
    [RENDER_SYNC_APP_ID_PARAM]: appId,
  });
  return `${path}?${params.toString()}`;
}
