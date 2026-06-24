import { useEffect, useState } from 'react';
import { isRenderBundle, type RenderBundle } from '../render/renderBundle';

const RENDER_BUNDLE_ENDPOINT = '/api/render-bundle';
const RENDER_EVENTS_ENDPOINT = '/api/render-events';

export function useRenderSyncPublisher(bundle: RenderBundle | null): void {
  useEffect(() => {
    if (!bundle) return;

    const abortController = new AbortController();
    void fetch(RENDER_BUNDLE_ENDPOINT, {
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
  }, [bundle]);
}

export function useRenderSyncReceiver(): RenderBundle | null {
  const [bundle, setBundle] = useState<RenderBundle | null>(null);

  useEffect(() => {
    let disposed = false;

    void fetch(RENDER_BUNDLE_ENDPOINT)
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

    const events = new EventSource(RENDER_EVENTS_ENDPOINT);
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
  }, []);

  return bundle;
}
