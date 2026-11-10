import { useState, type FormEvent } from 'react';
import { EMPTY_MEDIA_REQUIREMENTS } from '../render/renderBundle';
import {
  isRenderSyncAppId,
  readRenderSyncAppIdFromUrl,
  renderSyncAppIdLength,
  useRenderSyncReceiver,
  writeRenderSyncAppIdToUrl,
} from '../sync/renderSync';
import { WebGLPreview } from '../editor/WebGLPreview';

export function ViewerApp() {
  const [appId, setAppId] = useState<string | null>(() => readRenderSyncAppIdFromUrl());
  const [requestedAppId, setRequestedAppId] = useState('');
  const [appIdError, setAppIdError] = useState<string | null>(null);
  const bundle = useRenderSyncReceiver(appId);

  const submitAppId = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedAppId = requestedAppId.trim();
    if (!isRenderSyncAppId(normalizedAppId)) {
      setAppIdError(`Enter the ${renderSyncAppIdLength()} character code from the editor URL.`);
      return;
    }

    writeRenderSyncAppIdToUrl(normalizedAppId);
    setAppId(normalizedAppId);
    setAppIdError(null);
  };

  return (
    <main className="viewer-shell">
      <WebGLPreview
        active
        sceneDocument={bundle?.sceneDocument}
        sceneRevision={bundle?.sceneRevision}
        effectsBypass={bundle?.effectsBypass}
        fragmentShader={bundle?.shaderCode ?? ''}
        feedbackTextureCount={bundle?.feedbackTextureCount ?? 0}
        shaderArgs={bundle?.shaderArgs ?? []}
        bufferSlots={bundle?.bufferSlots ?? []}
        delaySlots={bundle?.delaySlots ?? []}
        envelopeSlots={bundle?.envelopeSlots ?? []}
        mediaRequirements={bundle?.media ?? EMPTY_MEDIA_REQUIREMENTS}
        showErrorOverlay={false}
      />
      {!appId ? (
        <div className="viewer-app-id-backdrop">
          <form className="viewer-app-id-modal" onSubmit={submitAppId}>
            <header>
              <h1>Viewer code</h1>
              <p>Enter the app-id from the editor URL.</p>
            </header>
            <input
              value={requestedAppId}
              onChange={(event) => {
                setRequestedAppId(event.currentTarget.value);
                setAppIdError(null);
              }}
              maxLength={renderSyncAppIdLength()}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Editor app-id"
              placeholder="Ab3x9"
            />
            {appIdError ? <p className="viewer-app-id-error">{appIdError}</p> : null}
            <button type="submit">Connect</button>
          </form>
        </div>
      ) : null}
    </main>
  );
}
