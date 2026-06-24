import type {
  CompileResult,
  ShaderArg,
  ShaderBufferSlot,
  ShaderDelaySlot,
  ShaderEnvelopeSlot,
  ShaderMediaRequirements,
} from '../graph/glsl';

export interface RenderBundle {
  version: 1;
  revision: number;
  patchName: string;
  shaderCode: string;
  shaderArgs: ShaderArg[];
  feedbackTextureCount: number;
  bufferSlots: ShaderBufferSlot[];
  delaySlots: ShaderDelaySlot[];
  envelopeSlots: ShaderEnvelopeSlot[];
  media: ShaderMediaRequirements;
}

export const EMPTY_MEDIA_REQUIREMENTS: ShaderMediaRequirements = {
  useMic: false,
  useCamera: false,
};

export function renderBundleFromCompileResult(
  compileResult: CompileResult,
  patchName: string,
  revision: number,
): RenderBundle | null {
  if (!compileResult.ok || !compileResult.shaderCode) return null;

  return {
    version: 1,
    revision,
    patchName,
    shaderCode: compileResult.shaderCode,
    shaderArgs: compileResult.shaderArgs,
    feedbackTextureCount: compileResult.feedbackTextureCount,
    bufferSlots: compileResult.bufferSlots,
    delaySlots: compileResult.delaySlots,
    envelopeSlots: compileResult.envelopeSlots,
    media: compileResult.media,
  };
}

export function renderBundleRevision(source: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function isRenderBundle(value: unknown): value is RenderBundle {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Partial<RenderBundle>;
  return candidate.version === 1 &&
    typeof candidate.revision === 'number' &&
    typeof candidate.patchName === 'string' &&
    typeof candidate.shaderCode === 'string' &&
    Array.isArray(candidate.shaderArgs) &&
    typeof candidate.feedbackTextureCount === 'number' &&
    Array.isArray(candidate.bufferSlots) &&
    Array.isArray(candidate.delaySlots) &&
    Array.isArray(candidate.envelopeSlots) &&
    !!candidate.media &&
    typeof candidate.media === 'object';
}
