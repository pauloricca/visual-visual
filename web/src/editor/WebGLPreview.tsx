import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ShaderArg, ShaderBufferSlot, ShaderDelaySlot, ShaderEnvelopeSlot, ShaderMediaRequirements, ShaderMeterSlot, ShaderScopeSlot } from '../graph/glsl';
import { EMPTY_MEDIA_REQUIREMENTS } from '../render/renderBundle';

interface Props {
  active?: boolean;
  fragmentShader: string;
  feedbackTextureCount?: number;
  shaderArgs?: ShaderArg[];
  bufferSlots?: ShaderBufferSlot[];
  delaySlots?: ShaderDelaySlot[];
  envelopeSlots?: ShaderEnvelopeSlot[];
  scopeSlots?: ShaderScopeSlot[];
  meterSlots?: ShaderMeterSlot[];
  mediaRequirements?: ShaderMediaRequirements;
  onFpsChange?: (fps: number) => void;
  showErrorOverlay?: boolean;
}

export interface WebGLPreviewHandle {
  downloadScreenshot: () => void;
}

interface ProgramState {
  program: WebGLProgram;
  uResolution: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
  uFrame: WebGLUniformLocation | null;
  uFeedback: Array<WebGLUniformLocation | null>;
  uShaderArgs: Map<string, WebGLUniformLocation | null>;
  uDelaySamplers: Map<string, WebGLUniformLocation | null>;
  uBufferSamplers: Map<string, WebGLUniformLocation | null>;
  uEnvelopeSamplers: Map<string, WebGLUniformLocation | null>;
  uMicLevel: WebGLUniformLocation | null;
  uCamera: WebGLUniformLocation | null;
  feedbackTextureCount: number;
  bufferSlots: ShaderBufferSlot[];
  delaySlots: ShaderDelaySlot[];
  envelopeSlots: ShaderEnvelopeSlot[];
  scopeSlots: ShaderScopeSlot[];
  meterSlots: ShaderMeterSlot[];
  mediaRequirements: ShaderMediaRequirements;
}

interface BlitProgramState {
  program: WebGLProgram;
  uTexture: WebGLUniformLocation | null;
}

interface ReduceProgramState {
  program: WebGLProgram;
  uTexture: WebGLUniformLocation | null;
  uSourceSize: WebGLUniformLocation | null;
  uInitialPass: WebGLUniformLocation | null;
}

interface StateResources {
  framebuffer: WebGLFramebuffer;
  meterFramebuffer: WebGLFramebuffer;
  displayTexture: WebGLTexture;
  feedbackTextures: [WebGLTexture[], WebGLTexture[]];
  delayTextures: WebGLTexture[][];
  bufferTextures: [WebGLTexture[], WebGLTexture[]];
  envelopeTextures: [WebGLTexture[], WebGLTexture[]];
  scopeTextures: WebGLTexture[];
  meterTextures: WebGLTexture[];
  meterReductionTextures: Array<[WebGLTexture, WebGLTexture]>;
  meterReadback: Float32Array<ArrayBuffer>;
  width: number;
  height: number;
  feedbackTextureCount: number;
  bufferSlotCount: number;
  delaySlotCount: number;
  envelopeSlotCount: number;
  scopeSlotCount: number;
  meterSlotCount: number;
  feedbackReadIndex: 0 | 1;
  bufferReadIndex: 0 | 1;
  envelopeReadIndex: 0 | 1;
  delayWriteIndex: number;
}

interface MediaResources {
  micStream: MediaStream | null;
  audioContext: AudioContext | null;
  analyser: AnalyserNode | null;
  micSamples: Uint8Array<ArrayBuffer> | null;
  cameraStream: MediaStream | null;
  cameraVideo: HTMLVideoElement | null;
  cameraTexture: WebGLTexture | null;
  cameraStartInFlight: boolean;
  cameraRetryBlocked: boolean;
  cameraRequestId: number;
}

type SetPreviewError = Dispatch<SetStateAction<string | null>>;

const MAX_DELAY_FRAMES = 32;
const DELAY_HISTORY_LENGTH = MAX_DELAY_FRAMES + 1;
const CAMERA_RETRY_INTERVAL_MS = 1000;
const METER_UPDATE_INTERVAL_FRAMES = 6;
export const WebGLPreview = forwardRef<WebGLPreviewHandle, Props>(function WebGLPreview({
  active = true,
  fragmentShader,
  feedbackTextureCount = 0,
  shaderArgs = [],
  bufferSlots = [],
  delaySlots = [],
  envelopeSlots = [],
  scopeSlots = [],
  meterSlots = [],
  mediaRequirements = EMPTY_MEDIA_REQUIREMENTS,
  onFpsChange,
  showErrorOverlay = true,
}: Props, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<WebGL2RenderingContext | null>(null);
  const vaoRef = useRef<WebGLVertexArrayObject | null>(null);
  const programRef = useRef<ProgramState | null>(null);
  const shaderArgsRef = useRef<ShaderArg[]>(shaderArgs);
  const bufferSlotsRef = useRef<ShaderBufferSlot[]>(bufferSlots);
  const delaySlotsRef = useRef<ShaderDelaySlot[]>(delaySlots);
  const envelopeSlotsRef = useRef<ShaderEnvelopeSlot[]>(envelopeSlots);
  const scopeSlotsRef = useRef<ShaderScopeSlot[]>(scopeSlots);
  const meterSlotsRef = useRef<ShaderMeterSlot[]>(meterSlots);
  const mediaRequirementsRef = useRef<ShaderMediaRequirements>(mediaRequirements);
  const onFpsChangeRef = useRef<Props['onFpsChange']>(onFpsChange);
  const activeRef = useRef(active);
  const animationFrameRef = useRef(0);
  const startRenderLoopRef = useRef<(() => void) | null>(null);
  const blitProgramRef = useRef<BlitProgramState | null>(null);
  const reduceProgramRef = useRef<ReduceProgramState | null>(null);
  const stateResourcesRef = useRef<StateResources | null>(null);
  const mediaResourcesRef = useRef<MediaResources>({
    micStream: null,
    audioContext: null,
    analyser: null,
    micSamples: null,
    cameraStream: null,
    cameraVideo: null,
    cameraTexture: null,
    cameraStartInFlight: false,
    cameraRetryBlocked: false,
    cameraRequestId: 0,
  });
  const frameRef = useRef(0);
  const startedAtRef = useRef(performance.now());
  const fpsSampleRef = useRef({ frames: 0, lastTime: performance.now() });
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    downloadScreenshot: () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        setError('Screenshot unavailable: missing canvas.');
        return;
      }

      canvas.toBlob((blob) => {
        if (!blob) {
          setError('Screenshot unavailable: could not encode PNG.');
          return;
        }

        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `visual-visual-${formatScreenshotTimestamp(new Date())}.png`;
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      }, 'image/png');
    },
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
    });

    if (!gl) {
      setError('WebGL2 unavailable');
      return;
    }

    glRef.current = gl;
    vaoRef.current = gl.createVertexArray();
    gl.bindVertexArray(vaoRef.current);
    const blitProgram = createProgram(gl, BLIT_FRAGMENT_SHADER, BLIT_VERTEX_SHADER);
    blitProgramRef.current = {
      program: blitProgram,
      uTexture: gl.getUniformLocation(blitProgram, 'u_texture'),
    };
    const reduceProgram = createProgram(gl, METER_REDUCE_FRAGMENT_SHADER, BLIT_VERTEX_SHADER);
    reduceProgramRef.current = {
      program: reduceProgram,
      uTexture: gl.getUniformLocation(reduceProgram, 'u_texture'),
      uSourceSize: gl.getUniformLocation(reduceProgram, 'u_source_size'),
      uInitialPass: gl.getUniformLocation(reduceProgram, 'u_initial_pass'),
    };

    let disposed = false;
    const render = () => {
      if (disposed || !activeRef.current) {
        animationFrameRef.current = 0;
        return;
      }

      resizeCanvasToDisplaySize(canvas, gl);
      const program = programRef.current;
      if (program) {
        try {
          gl.bindVertexArray(vaoRef.current);
          if (program.feedbackTextureCount > 0 || program.delaySlots.length > 0 || program.bufferSlots.length > 0 || program.envelopeSlots.length > 0 || program.scopeSlots.length > 0 || program.meterSlots.length > 0) {
            const blitProgramState = blitProgramRef.current;
            const reduceProgramState = reduceProgramRef.current;
            if (!blitProgramState) {
              throw new Error('Missing WebGL display program.');
            }
            if (!reduceProgramState) {
              throw new Error('Missing WebGL meter program.');
            }

            let resources = stateResourcesRef.current;
            if (
              !resources ||
              resources.width !== canvas.width ||
              resources.height !== canvas.height ||
              resources.feedbackTextureCount !== program.feedbackTextureCount ||
              resources.delaySlotCount !== program.delaySlots.length ||
              resources.bufferSlotCount !== program.bufferSlots.length ||
              resources.envelopeSlotCount !== program.envelopeSlots.length ||
              resources.scopeSlotCount !== program.scopeSlots.length ||
              resources.meterSlotCount !== program.meterSlots.length
            ) {
              if (resources) {
                disposeStateResources(gl, resources);
              }
              resources = createStateResources(
                gl,
                canvas.width,
                canvas.height,
                program.feedbackTextureCount,
                program.delaySlots.length,
                program.bufferSlots.length,
                program.envelopeSlots.length,
                program.scopeSlots.length,
                program.meterSlots.length,
              );
              stateResourcesRef.current = resources;
            }

            renderFeedbackFrame(
              gl,
              canvas,
              program,
              blitProgramState,
              reduceProgramState,
              resources,
              frameRef.current,
              startedAtRef.current,
              shaderArgsRef.current,
              program.delaySlots,
              program.bufferSlots,
              program.envelopeSlots,
              program.scopeSlots,
              program.meterSlots,
              mediaResourcesRef.current,
            );
          } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.useProgram(program.program);
            setCommonUniforms(gl, canvas, program, frameRef.current, startedAtRef.current);
            setShaderArgUniforms(gl, program, shaderArgsRef.current);
            setMediaUniforms(gl, program, mediaResourcesRef.current, 0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
          }
          frameRef.current = (frameRef.current + 1) | 0;
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
      } else {
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      updateFps(fpsSampleRef.current, onFpsChangeRef.current);
      animationFrameRef.current = requestAnimationFrame(render);
    };

    startRenderLoopRef.current = () => {
      if (animationFrameRef.current || !activeRef.current) return;

      fpsSampleRef.current = { frames: 0, lastTime: performance.now() };
      animationFrameRef.current = requestAnimationFrame(render);
    };
    startRenderLoopRef.current();

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
      startRenderLoopRef.current = null;
      if (programRef.current) {
        gl.deleteProgram(programRef.current.program);
        programRef.current = null;
      }
      if (blitProgramRef.current) {
        gl.deleteProgram(blitProgramRef.current.program);
        blitProgramRef.current = null;
      }
      if (reduceProgramRef.current) {
        gl.deleteProgram(reduceProgramRef.current.program);
        reduceProgramRef.current = null;
      }
      if (stateResourcesRef.current) {
        disposeStateResources(gl, stateResourcesRef.current);
        stateResourcesRef.current = null;
      }
      stopMic(mediaResourcesRef.current);
      stopCamera(gl, mediaResourcesRef.current);
      if (vaoRef.current) {
        gl.deleteVertexArray(vaoRef.current);
        vaoRef.current = null;
      }
      glRef.current = null;
    };
  }, []);

  useEffect(() => {
    activeRef.current = active;
    if (active) {
      startRenderLoopRef.current?.();
      return;
    }

    cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = 0;
    fpsSampleRef.current = { frames: 0, lastTime: performance.now() };
    onFpsChangeRef.current?.(0);
    stopMic(mediaResourcesRef.current);
    const gl = glRef.current;
    if (gl) {
      stopCamera(gl, mediaResourcesRef.current);
    } else {
      releaseCameraStream(mediaResourcesRef.current);
    }
  }, [active]);

  useEffect(() => {
    shaderArgsRef.current = shaderArgs;
  }, [shaderArgs]);

  useEffect(() => {
    bufferSlotsRef.current = bufferSlots;
  }, [bufferSlots]);

  useEffect(() => {
    delaySlotsRef.current = delaySlots;
  }, [delaySlots]);

  useEffect(() => {
    envelopeSlotsRef.current = envelopeSlots;
  }, [envelopeSlots]);

  useEffect(() => {
    scopeSlotsRef.current = scopeSlots;
  }, [scopeSlots]);

  useEffect(() => {
    meterSlotsRef.current = meterSlots;
  }, [meterSlots]);

  useEffect(() => {
    mediaRequirementsRef.current = mediaRequirements;
  }, [mediaRequirements]);

  useEffect(() => {
    onFpsChangeRef.current = onFpsChange;
  }, [onFpsChange]);

  useEffect(() => {
    if (!active) {
      stopMic(mediaResourcesRef.current);
      return;
    }

    if (mediaRequirements.useMic) {
      void startMic(mediaResourcesRef.current, setError);
    } else {
      stopMic(mediaResourcesRef.current);
    }

    return () => {
      stopMic(mediaResourcesRef.current);
    };
  }, [active, mediaRequirements.useMic]);

  useEffect(() => {
    const gl = glRef.current;
    if (!gl) return;

    if (!active || !mediaRequirements.useCamera) {
      stopCamera(gl, mediaResourcesRef.current);
      return;
    }

    const mediaResources = mediaResourcesRef.current;
    mediaResources.cameraRetryBlocked = false;

    const ensureCameraIsRunning = () => {
      void ensureCamera(gl, mediaResources, setError);
    };
    const ensureCameraAfterWake = () => {
      if (document.visibilityState === 'visible') {
        ensureCameraIsRunning();
      }
    };

    ensureCameraIsRunning();
    const retryInterval = window.setInterval(ensureCameraIsRunning, CAMERA_RETRY_INTERVAL_MS);
    document.addEventListener('visibilitychange', ensureCameraAfterWake);
    window.addEventListener('focus', ensureCameraIsRunning);
    window.addEventListener('pageshow', ensureCameraIsRunning);

    return () => {
      window.clearInterval(retryInterval);
      document.removeEventListener('visibilitychange', ensureCameraAfterWake);
      window.removeEventListener('focus', ensureCameraIsRunning);
      window.removeEventListener('pageshow', ensureCameraIsRunning);
      stopCamera(gl, mediaResources);
    };
  }, [active, mediaRequirements.useCamera]);

  useEffect(() => {
    const gl = glRef.current;
    if (!active || !gl || !fragmentShader) return;

    try {
      const nextProgram = createProgram(gl, fragmentShader);
      const previousProgram = programRef.current;
      programRef.current = {
        program: nextProgram,
        uResolution: gl.getUniformLocation(nextProgram, 'u_resolution'),
        uTime: gl.getUniformLocation(nextProgram, 'u_time'),
        uFrame: gl.getUniformLocation(nextProgram, 'u_frame'),
        uFeedback: Array.from({ length: feedbackTextureCount }, (_, index) =>
          gl.getUniformLocation(nextProgram, `u_feedback${index}`),
        ),
        uShaderArgs: new Map(shaderArgsRef.current.map((arg) => [
          arg.name,
          gl.getUniformLocation(nextProgram, arg.name),
        ])),
        uDelaySamplers: new Map(delaySlotsRef.current.map((slot) => [
          slot.samplerName,
          gl.getUniformLocation(nextProgram, slot.samplerName),
        ])),
        uBufferSamplers: new Map(bufferSlotsRef.current.map((slot) => [
          slot.samplerName,
          gl.getUniformLocation(nextProgram, slot.samplerName),
        ])),
        uEnvelopeSamplers: new Map(envelopeSlotsRef.current.map((slot) => [
          slot.samplerName,
          gl.getUniformLocation(nextProgram, slot.samplerName),
        ])),
        uMicLevel: gl.getUniformLocation(nextProgram, 'u_mic_level'),
        uCamera: gl.getUniformLocation(nextProgram, 'u_camera'),
        feedbackTextureCount,
        bufferSlots: bufferSlotsRef.current,
        delaySlots: delaySlotsRef.current,
        envelopeSlots: envelopeSlotsRef.current,
        scopeSlots: scopeSlotsRef.current,
        meterSlots: meterSlotsRef.current,
        mediaRequirements: mediaRequirementsRef.current,
      };
      if (previousProgram) {
        gl.deleteProgram(previousProgram.program);
      }
      if (stateResourcesRef.current) {
        disposeStateResources(gl, stateResourcesRef.current);
        stateResourcesRef.current = null;
      }
      frameRef.current = 0;
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [active, feedbackTextureCount, fragmentShader]);

  return (
    <>
      <canvas ref={canvasRef} className="webgl-preview" aria-hidden="true" />
      {showErrorOverlay && error ? <div className="webgl-error">{error}</div> : null}
    </>
  );
});

function formatScreenshotTimestamp(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function updateFps(
  sample: { frames: number; lastTime: number },
  onFpsChange: Props['onFpsChange'],
): void {
  const now = performance.now();
  sample.frames += 1;
  const elapsed = now - sample.lastTime;
  if (elapsed < 500) return;

  onFpsChange?.(Math.round((sample.frames * 1000) / elapsed));
  sample.frames = 0;
  sample.lastTime = now;
}

function renderFeedbackFrame(
  gl: WebGL2RenderingContext,
  canvas: HTMLCanvasElement,
  program: ProgramState,
  blitProgram: BlitProgramState,
  reduceProgram: ReduceProgramState,
  resources: StateResources,
  frame: number,
  startedAt: number,
  shaderArgs: ShaderArg[],
  delaySlots: ShaderDelaySlot[],
  bufferSlots: ShaderBufferSlot[],
  envelopeSlots: ShaderEnvelopeSlot[],
  scopeSlots: ShaderScopeSlot[],
  meterSlots: ShaderMeterSlot[],
  mediaResources: MediaResources,
): void {
  const feedbackWriteIndex: 0 | 1 = resources.feedbackReadIndex === 0 ? 1 : 0;
  const bufferWriteIndex: 0 | 1 = resources.bufferReadIndex === 0 ? 1 : 0;
  const envelopeWriteIndex: 0 | 1 = resources.envelopeReadIndex === 0 ? 1 : 0;
  const drawBuffers: number[] = [gl.COLOR_ATTACHMENT0];

  gl.bindFramebuffer(gl.FRAMEBUFFER, resources.framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resources.displayTexture, 0);
  for (let index = 0; index < resources.feedbackTextureCount; index += 1) {
    const attachment = gl.COLOR_ATTACHMENT1 + index;
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      attachment,
      gl.TEXTURE_2D,
      resources.feedbackTextures[feedbackWriteIndex][index],
      0,
    );
    drawBuffers.push(attachment);
  }

  const delayAttachmentOffset = 1 + resources.feedbackTextureCount;
  for (let index = 0; index < delaySlots.length; index += 1) {
    const attachment = gl.COLOR_ATTACHMENT0 + delayAttachmentOffset + index;
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      attachment,
      gl.TEXTURE_2D,
      resources.delayTextures[index][resources.delayWriteIndex],
      0,
    );
    drawBuffers.push(attachment);
  }

  const bufferAttachmentOffset = delayAttachmentOffset + delaySlots.length;
  for (let index = 0; index < bufferSlots.length; index += 1) {
    const attachment = gl.COLOR_ATTACHMENT0 + bufferAttachmentOffset + index;
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      attachment,
      gl.TEXTURE_2D,
      resources.bufferTextures[bufferWriteIndex][index],
      0,
    );
    drawBuffers.push(attachment);
  }

  const envelopeAttachmentOffset = bufferAttachmentOffset + bufferSlots.length;
  for (let index = 0; index < envelopeSlots.length; index += 1) {
    const attachment = gl.COLOR_ATTACHMENT0 + envelopeAttachmentOffset + index;
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      attachment,
      gl.TEXTURE_2D,
      resources.envelopeTextures[envelopeWriteIndex][index],
      0,
    );
    drawBuffers.push(attachment);
  }

  const scopeAttachmentOffset = envelopeAttachmentOffset + envelopeSlots.length;
  for (let index = 0; index < scopeSlots.length; index += 1) {
    const attachment = gl.COLOR_ATTACHMENT0 + scopeAttachmentOffset + index;
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      attachment,
      gl.TEXTURE_2D,
      resources.scopeTextures[index],
      0,
    );
    drawBuffers.push(attachment);
  }

  const meterAttachmentOffset = scopeAttachmentOffset + scopeSlots.length;
  for (let index = 0; index < meterSlots.length; index += 1) {
    const attachment = gl.COLOR_ATTACHMENT0 + meterAttachmentOffset + index;
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      attachment,
      gl.TEXTURE_2D,
      resources.meterTextures[index],
      0,
    );
    drawBuffers.push(attachment);
  }

  gl.drawBuffers(drawBuffers);

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`Feedback framebuffer is incomplete: ${status}.`);
  }

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(program.program);
  setCommonUniforms(gl, canvas, program, frame, startedAt);
  setShaderArgUniforms(gl, program, shaderArgs);
  for (let index = 0; index < resources.feedbackTextureCount; index += 1) {
    gl.activeTexture(gl.TEXTURE0 + index);
    gl.bindTexture(gl.TEXTURE_2D, resources.feedbackTextures[resources.feedbackReadIndex][index]);
    gl.uniform1i(program.uFeedback[index], index);
  }

  for (let index = 0; index < delaySlots.length; index += 1) {
    const textureUnit = resources.feedbackTextureCount + index;
    const delayFrames = delayFrameCount(delaySlots[index], shaderArgs);
    const readIndex = positiveModulo(resources.delayWriteIndex - delayFrames, DELAY_HISTORY_LENGTH);
    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, resources.delayTextures[index][readIndex]);
    gl.uniform1i(program.uDelaySamplers.get(delaySlots[index].samplerName) ?? null, textureUnit);
  }

  const bufferTextureOffset = resources.feedbackTextureCount + delaySlots.length;
  for (let index = 0; index < bufferSlots.length; index += 1) {
    const textureUnit = bufferTextureOffset + index;
    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, resources.bufferTextures[resources.bufferReadIndex][index]);
    gl.uniform1i(program.uBufferSamplers.get(bufferSlots[index].samplerName) ?? null, textureUnit);
  }

  const envelopeTextureOffset = bufferTextureOffset + bufferSlots.length;
  for (let index = 0; index < envelopeSlots.length; index += 1) {
    const textureUnit = envelopeTextureOffset + index;
    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, resources.envelopeTextures[resources.envelopeReadIndex][index]);
    gl.uniform1i(program.uEnvelopeSamplers.get(envelopeSlots[index].samplerName) ?? null, textureUnit);
  }

  setMediaUniforms(gl, program, mediaResources, envelopeTextureOffset + envelopeSlots.length);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  resources.feedbackReadIndex = feedbackWriteIndex;
  resources.bufferReadIndex = bufferWriteIndex;
  resources.envelopeReadIndex = envelopeWriteIndex;
  resources.delayWriteIndex = (resources.delayWriteIndex + 1) % DELAY_HISTORY_LENGTH;

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.drawBuffers([gl.BACK]);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(blitProgram.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, resources.displayTexture);
  gl.uniform1i(blitProgram.uTexture, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  blitScopePreviews(gl, canvas, blitProgram, resources, scopeSlots);
  if (frame % METER_UPDATE_INTERVAL_FRAMES === 0) {
    updateMeterLabels(gl, canvas, reduceProgram, resources, meterSlots);
  }
}

function setCommonUniforms(
  gl: WebGL2RenderingContext,
  canvas: HTMLCanvasElement,
  program: ProgramState,
  frame: number,
  startedAt: number,
): void {
  gl.uniform2f(program.uResolution, canvas.width, canvas.height);
  gl.uniform1f(program.uTime, (performance.now() - startedAt) / 1000);
  gl.uniform1i(program.uFrame, frame);
}

function setShaderArgUniforms(
  gl: WebGL2RenderingContext,
  program: ProgramState,
  shaderArgs: ShaderArg[],
): void {
  for (const arg of shaderArgs) {
    gl.uniform1f(program.uShaderArgs.get(arg.name) ?? null, arg.value);
  }
}

function setMediaUniforms(
  gl: WebGL2RenderingContext,
  program: ProgramState,
  mediaResources: MediaResources,
  firstTextureUnit: number,
): void {
  if (program.mediaRequirements.useMic) {
    gl.uniform1f(program.uMicLevel, readMicLevel(mediaResources));
  }

  if (!program.mediaRequirements.useCamera) return;

  const maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number;
  if (firstTextureUnit >= maxTextureUnits) {
    throw new Error(`This GPU can sample ${maxTextureUnits} textures at once.`);
  }

  // Upload on the camera's unit so updateCameraTexture cannot clear a state sampler.
  gl.activeTexture(gl.TEXTURE0 + firstTextureUnit);
  const texture = getCameraTexture(gl, mediaResources);
  updateCameraTexture(gl, mediaResources, texture);
  gl.activeTexture(gl.TEXTURE0 + firstTextureUnit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(program.uCamera, firstTextureUnit);
}

function readMicLevel(mediaResources: MediaResources): number {
  const analyser = mediaResources.analyser;
  const samples = mediaResources.micSamples;
  if (!analyser || !samples) return 0;

  analyser.getByteTimeDomainData(samples);
  let total = 0;
  for (const sample of samples) {
    const centered = (sample - 128) / 128;
    total += centered * centered;
  }

  return Math.min(Math.sqrt(total / samples.length) * 2.0, 1);
}

function delayFrameCount(slot: ShaderDelaySlot, shaderArgs: ShaderArg[]): number {
  const arg = shaderArgs.find((candidate) => candidate.name === slot.frameArgName);
  const rawFrames = Math.round(arg?.value ?? 1);
  if (!Number.isFinite(rawFrames)) return 1;
  return Math.min(Math.max(rawFrames, 1), MAX_DELAY_FRAMES);
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function blitScopePreviews(
  gl: WebGL2RenderingContext,
  canvas: HTMLCanvasElement,
  blitProgram: BlitProgramState,
  resources: StateResources,
  scopeSlots: ShaderScopeSlot[],
): void {
  if (scopeSlots.length === 0) return;

  const canvasRect = canvas.getBoundingClientRect();
  if (canvasRect.width <= 0 || canvasRect.height <= 0) return;

  const scaleX = canvas.width / canvasRect.width;
  const scaleY = canvas.height / canvasRect.height;

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.drawBuffers([gl.BACK]);
  gl.useProgram(blitProgram.program);
  gl.uniform1i(blitProgram.uTexture, 0);
  gl.enable(gl.SCISSOR_TEST);

  for (let index = 0; index < scopeSlots.length; index += 1) {
    const element = findScopePreviewElement(scopeSlots[index].nodeId);
    if (!element) continue;

    const rect = element.getBoundingClientRect();
    const left = Math.max(rect.left, canvasRect.left);
    const top = Math.max(rect.top, canvasRect.top);
    const right = Math.min(rect.right, canvasRect.right);
    const bottom = Math.min(rect.bottom, canvasRect.bottom);
    if (right <= left || bottom <= top) continue;

    const x = Math.round((left - canvasRect.left) * scaleX);
    const y = Math.round((canvasRect.bottom - bottom) * scaleY);
    const width = Math.max(1, Math.round((right - left) * scaleX));
    const height = Math.max(1, Math.round((bottom - top) * scaleY));

    gl.viewport(x, y, width, height);
    gl.scissor(x, y, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, resources.scopeTextures[index]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  gl.disable(gl.SCISSOR_TEST);
  gl.viewport(0, 0, canvas.width, canvas.height);
}

function updateMeterLabels(
  gl: WebGL2RenderingContext,
  canvas: HTMLCanvasElement,
  reduceProgram: ReduceProgramState,
  resources: StateResources,
  meterSlots: ShaderMeterSlot[],
): void {
  if (meterSlots.length === 0) return;

  gl.bindFramebuffer(gl.FRAMEBUFFER, resources.meterFramebuffer);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  gl.useProgram(reduceProgram.program);
  gl.uniform1i(reduceProgram.uTexture, 0);

  for (let index = 0; index < meterSlots.length; index += 1) {
    const valueRange = reduceMeterTexture(
      gl,
      canvas.width,
      canvas.height,
      reduceProgram,
      resources,
      resources.meterTextures[index],
      resources.meterReductionTextures[index],
    );
    const element = findMeterLabelElement(meterSlots[index].nodeId);
    if (element) {
      updateMeterLabelElement(element, valueRange);
    }
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.drawBuffers([gl.BACK]);
  gl.viewport(0, 0, canvas.width, canvas.height);
}

function reduceMeterTexture(
  gl: WebGL2RenderingContext,
  sourceWidth: number,
  sourceHeight: number,
  reduceProgram: ReduceProgramState,
  resources: StateResources,
  initialTexture: WebGLTexture,
  reductionTextures: [WebGLTexture, WebGLTexture],
): { min: number; max: number } {
  let texture = initialTexture;
  let width = sourceWidth;
  let height = sourceHeight;
  let writeIndex: 0 | 1 = 0;
  let initialPass = true;

  while (initialPass || width > 1 || height > 1) {
    const nextWidth = Math.max(1, Math.ceil(width / 2));
    const nextHeight = Math.max(1, Math.ceil(height / 2));
    const outputTexture = reductionTextures[writeIndex];

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTexture, 0);
    gl.viewport(0, 0, nextWidth, nextHeight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform2f(reduceProgram.uSourceSize, width, height);
    gl.uniform1i(reduceProgram.uInitialPass, initialPass ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    texture = outputTexture;
    width = nextWidth;
    height = nextHeight;
    writeIndex = writeIndex === 0 ? 1 : 0;
    initialPass = false;
  }

  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  gl.readPixels(0, 0, 1, 1, gl.RG, gl.FLOAT, resources.meterReadback);
  return {
    min: resources.meterReadback[0] ?? 0,
    max: resources.meterReadback[1] ?? 0,
  };
}

function findScopePreviewElement(nodeId: string): HTMLElement | null {
  const escaped = typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(nodeId)
    : nodeId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return document.querySelector<HTMLElement>(`[data-scope-node-id="${escaped}"]`);
}

function findMeterLabelElement(nodeId: string): HTMLElement | null {
  const escaped = typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(nodeId)
    : nodeId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return document.querySelector<HTMLElement>(`[data-meter-node-id="${escaped}"]`);
}

function updateMeterLabelElement(element: HTMLElement, valueRange: { min: number; max: number }): void {
  const minElement = element.querySelector<HTMLElement>('[data-meter-min]');
  const maxElement = element.querySelector<HTMLElement>('[data-meter-max]');

  if (minElement && maxElement) {
    minElement.textContent = formatMeterValue(valueRange.min);
    maxElement.textContent = formatMeterValue(valueRange.max);
    return;
  }

  element.textContent = `min ${formatMeterValue(valueRange.min)}\nmax ${formatMeterValue(valueRange.max)}`;
}

function formatMeterValue(value: number): string {
  if (!Number.isFinite(value)) return '--';
  if (Math.abs(value) >= 10000 || (Math.abs(value) > 0 && Math.abs(value) < 0.001)) {
    return value.toExponential(3);
  }
  return value.toFixed(3);
}

async function startMic(
  mediaResources: MediaResources,
  setError: SetPreviewError,
): Promise<void> {
  if (mediaResources.micStream) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const AudioContextConstructor = window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) {
      throw new Error('Web Audio is unavailable.');
    }
    const audioContext = new AudioContextConstructor();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    audioContext.createMediaStreamSource(stream).connect(analyser);

    mediaResources.micStream = stream;
    mediaResources.audioContext = audioContext;
    mediaResources.analyser = analyser;
    mediaResources.micSamples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    setError(null);
  } catch (caught) {
    stopMic(mediaResources);
    setError(`Microphone unavailable: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

function stopMic(mediaResources: MediaResources): void {
  mediaResources.micStream?.getTracks().forEach((track) => track.stop());
  void mediaResources.audioContext?.close();
  mediaResources.micStream = null;
  mediaResources.audioContext = null;
  mediaResources.analyser = null;
  mediaResources.micSamples = null;
}

async function ensureCamera(
  gl: WebGL2RenderingContext,
  mediaResources: MediaResources,
  setError: SetPreviewError,
): Promise<void> {
  if (mediaResources.cameraRetryBlocked || mediaResources.cameraStartInFlight) return;
  if (hasLiveCameraStream(mediaResources)) return;

  releaseCameraStream(mediaResources);
  mediaResources.cameraStartInFlight = true;
  const requestId = ++mediaResources.cameraRequestId;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
      },
    });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    await video.play();

    if (requestId !== mediaResources.cameraRequestId) {
      stream.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
      return;
    }

    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        releaseCameraStream(mediaResources);
      });
    }

    mediaResources.cameraStream = stream;
    mediaResources.cameraVideo = video;
    mediaResources.cameraTexture = mediaResources.cameraTexture ?? createMediaTexture(gl);
    clearCameraError(setError);
  } catch (caught) {
    releaseCameraStream(mediaResources);
    if (isCameraPermissionError(caught)) {
      mediaResources.cameraRetryBlocked = true;
      setError(`Camera unavailable: ${caught instanceof Error ? caught.message : String(caught)}`);
    } else {
      clearCameraError(setError);
    }
  } finally {
    mediaResources.cameraStartInFlight = false;
  }
}

function stopCamera(gl: WebGL2RenderingContext, mediaResources: MediaResources): void {
  mediaResources.cameraRequestId += 1;
  mediaResources.cameraStartInFlight = false;
  mediaResources.cameraRetryBlocked = false;
  releaseCameraStream(mediaResources);
  if (mediaResources.cameraTexture) {
    gl.deleteTexture(mediaResources.cameraTexture);
  }
  mediaResources.cameraTexture = null;
}

function releaseCameraStream(mediaResources: MediaResources): void {
  mediaResources.cameraStream?.getTracks().forEach((track) => track.stop());
  if (mediaResources.cameraVideo) {
    mediaResources.cameraVideo.pause();
    mediaResources.cameraVideo.srcObject = null;
  }
  mediaResources.cameraStream = null;
  mediaResources.cameraVideo = null;
}

function hasLiveCameraStream(mediaResources: MediaResources): boolean {
  return mediaResources.cameraStream?.getVideoTracks().some((track) => track.readyState === 'live') ?? false;
}

function isCameraPermissionError(caught: unknown): boolean {
  if (!(caught instanceof DOMException)) return false;
  return caught.name === 'NotAllowedError' ||
    caught.name === 'PermissionDeniedError' ||
    caught.name === 'SecurityError';
}

function clearCameraError(setError: SetPreviewError): void {
  setError((currentError) => currentError?.startsWith('Camera unavailable:') ? null : currentError);
}

function getCameraTexture(gl: WebGL2RenderingContext, mediaResources: MediaResources): WebGLTexture {
  if (!mediaResources.cameraTexture) {
    mediaResources.cameraTexture = createMediaTexture(gl);
  }
  return mediaResources.cameraTexture;
}

function createMediaTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error('Could not create camera texture.');
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 255]),
  );
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function updateCameraTexture(
  gl: WebGL2RenderingContext,
  mediaResources: MediaResources,
  texture: WebGLTexture,
): void {
  const video = mediaResources.cameraVideo;
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

function createStateResources(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  feedbackTextureCount: number,
  delaySlotCount: number,
  bufferSlotCount: number,
  envelopeSlotCount: number,
  scopeSlotCount: number,
  meterSlotCount: number,
): StateResources {
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error('Stateful nodes need EXT_color_buffer_float, which this browser/GPU did not expose.');
  }

  const maxColorAttachments = gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) as number;
  const maxDrawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS) as number;
  const maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number;
  const stateOutputCount = feedbackTextureCount + delaySlotCount + bufferSlotCount + envelopeSlotCount + scopeSlotCount + meterSlotCount;
  const sampledStateCount = feedbackTextureCount + delaySlotCount + bufferSlotCount + envelopeSlotCount;
  if (stateOutputCount + 1 > Math.min(maxColorAttachments, maxDrawBuffers)) {
    throw new Error(`This GPU can render ${Math.min(maxColorAttachments, maxDrawBuffers) - 1} state textures at once.`);
  }
  if (sampledStateCount > maxTextureUnits) {
    throw new Error(`This GPU can sample ${maxTextureUnits} state textures at once.`);
  }

  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) {
    throw new Error('Could not create feedback framebuffer.');
  }
  const meterFramebuffer = gl.createFramebuffer();
  if (!meterFramebuffer) {
    gl.deleteFramebuffer(framebuffer);
    throw new Error('Could not create meter framebuffer.');
  }

  const displayTexture = createTexture(gl, width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
  const feedbackTextures: [WebGLTexture[], WebGLTexture[]] = [[], []];
  for (let ping = 0; ping < 2; ping += 1) {
    for (let index = 0; index < feedbackTextureCount; index += 1) {
      feedbackTextures[ping].push(createTexture(gl, width, height, gl.RGBA32F, gl.RGBA, gl.FLOAT));
    }
  }

  const delayTextures: WebGLTexture[][] = [];
  for (let slot = 0; slot < delaySlotCount; slot += 1) {
    const history: WebGLTexture[] = [];
    for (let index = 0; index < DELAY_HISTORY_LENGTH; index += 1) {
      history.push(createTexture(gl, width, height, gl.R32F, gl.RED, gl.FLOAT));
    }
    delayTextures.push(history);
  }

  const bufferTextures: [WebGLTexture[], WebGLTexture[]] = [[], []];
  for (let ping = 0; ping < 2; ping += 1) {
    for (let index = 0; index < bufferSlotCount; index += 1) {
      bufferTextures[ping].push(createTexture(gl, width, height, gl.RG32F, gl.RG, gl.FLOAT));
    }
  }

  const envelopeTextures: [WebGLTexture[], WebGLTexture[]] = [[], []];
  for (let ping = 0; ping < 2; ping += 1) {
    for (let index = 0; index < envelopeSlotCount; index += 1) {
      envelopeTextures[ping].push(createTexture(gl, width, height, gl.R32F, gl.RED, gl.FLOAT));
    }
  }

  const scopeTextures: WebGLTexture[] = [];
  for (let index = 0; index < scopeSlotCount; index += 1) {
    scopeTextures.push(createTexture(gl, width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE));
  }

  const meterTextures: WebGLTexture[] = [];
  const meterReductionTextures: Array<[WebGLTexture, WebGLTexture]> = [];
  for (let index = 0; index < meterSlotCount; index += 1) {
    meterTextures.push(createTexture(gl, width, height, gl.R32F, gl.RED, gl.FLOAT));
    meterReductionTextures.push([
      createTexture(gl, width, height, gl.RG32F, gl.RG, gl.FLOAT),
      createTexture(gl, width, height, gl.RG32F, gl.RG, gl.FLOAT),
    ]);
  }

  return {
    framebuffer,
    meterFramebuffer,
    displayTexture,
    feedbackTextures,
    delayTextures,
    bufferTextures,
    envelopeTextures,
    scopeTextures,
    meterTextures,
    meterReductionTextures,
    meterReadback: new Float32Array(2),
    width,
    height,
    feedbackTextureCount,
    bufferSlotCount,
    delaySlotCount,
    envelopeSlotCount,
    scopeSlotCount,
    meterSlotCount,
    feedbackReadIndex: 0,
    bufferReadIndex: 0,
    envelopeReadIndex: 0,
    delayWriteIndex: 0,
  };
}

function createTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  internalFormat: number,
  format: number,
  type: number,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error('Could not create feedback texture.');
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function disposeStateResources(gl: WebGL2RenderingContext, resources: StateResources): void {
  gl.deleteFramebuffer(resources.framebuffer);
  gl.deleteFramebuffer(resources.meterFramebuffer);
  gl.deleteTexture(resources.displayTexture);
  for (const textureSet of resources.feedbackTextures) {
    for (const texture of textureSet) {
      gl.deleteTexture(texture);
    }
  }
  for (const history of resources.delayTextures) {
    for (const texture of history) {
      gl.deleteTexture(texture);
    }
  }
  for (const textureSet of resources.bufferTextures) {
    for (const texture of textureSet) {
      gl.deleteTexture(texture);
    }
  }
  for (const textureSet of resources.envelopeTextures) {
    for (const texture of textureSet) {
      gl.deleteTexture(texture);
    }
  }
  for (const texture of resources.scopeTextures) {
    gl.deleteTexture(texture);
  }
  for (const texture of resources.meterTextures) {
    gl.deleteTexture(texture);
  }
  for (const textureSet of resources.meterReductionTextures) {
    for (const texture of textureSet) {
      gl.deleteTexture(texture);
    }
  }
}

function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext): void {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(canvas.clientWidth * pixelRatio));
  const height = Math.max(1, Math.floor(canvas.clientHeight * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, canvas.width, canvas.height);
}

function createProgram(
  gl: WebGL2RenderingContext,
  fragmentSource: string,
  vertexSource = VERTEX_SHADER,
): WebGLProgram {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) {
    throw new Error('Could not create WebGL program.');
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || 'Unknown program link error.';
    gl.deleteProgram(program);
    throw new Error(log);
  }

  return program;
}

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('Could not create WebGL shader.');
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'Unknown shader compile error.';
    gl.deleteShader(shader);
    throw new Error(log);
  }

  return shader;
}

const VERTEX_SHADER = `#version 300 es
precision highp float;

const vec2 POSITIONS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0),
  vec2(-1.0, 3.0)
);

void main() {
  gl_Position = vec4(POSITIONS[gl_VertexID], 0.0, 1.0);
}
`;

const BLIT_VERTEX_SHADER = `#version 300 es
precision highp float;

const vec2 POSITIONS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0),
  vec2(-1.0, 3.0)
);

out vec2 v_uv;

void main() {
  vec2 position = POSITIONS[gl_VertexID];
  gl_Position = vec4(position, 0.0, 1.0);
  v_uv = position * 0.5 + 0.5;
}
`;

const BLIT_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_texture;
in vec2 v_uv;
out vec4 fragColor;

void main() {
  fragColor = texture(u_texture, clamp(v_uv, 0.0, 1.0));
}
`;

const METER_REDUCE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_texture;
uniform vec2 u_source_size;
uniform int u_initial_pass;
out vec2 fragColor;

void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 2;
  ivec2 sourceSize = ivec2(u_source_size);
  float minValue = 3.402823e38;
  float maxValue = -3.402823e38;

  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      ivec2 coord = base + ivec2(x, y);
      if (coord.x < sourceSize.x && coord.y < sourceSize.y) {
        vec2 sampleRange = u_initial_pass == 1
          ? vec2(texelFetch(u_texture, coord, 0).r)
          : texelFetch(u_texture, coord, 0).rg;
        minValue = min(minValue, sampleRange.x);
        maxValue = max(maxValue, sampleRange.y);
      }
    }
  }

  fragColor = vec2(minValue, maxValue);
}
`;
