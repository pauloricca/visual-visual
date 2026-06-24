import { EMPTY_MEDIA_REQUIREMENTS } from '../render/renderBundle';
import { useRenderSyncReceiver } from '../sync/renderSync';
import { WebGLPreview } from '../editor/WebGLPreview';

export function ViewerApp() {
  const bundle = useRenderSyncReceiver();

  return (
    <main className="viewer-shell">
      <WebGLPreview
        active
        fragmentShader={bundle?.shaderCode ?? ''}
        feedbackTextureCount={bundle?.feedbackTextureCount ?? 0}
        shaderArgs={bundle?.shaderArgs ?? []}
        bufferSlots={bundle?.bufferSlots ?? []}
        delaySlots={bundle?.delaySlots ?? []}
        envelopeSlots={bundle?.envelopeSlots ?? []}
        mediaRequirements={bundle?.media ?? EMPTY_MEDIA_REQUIREMENTS}
        showErrorOverlay={false}
      />
    </main>
  );
}
