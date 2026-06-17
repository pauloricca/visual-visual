import { useEffect, useRef, useState } from 'react';

interface Props {
  fragmentShader: string;
}

interface ProgramState {
  program: WebGLProgram;
  uResolution: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
  uFrame: WebGLUniformLocation | null;
}

export function WebGLPreview({ fragmentShader }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<WebGL2RenderingContext | null>(null);
  const vaoRef = useRef<WebGLVertexArrayObject | null>(null);
  const programRef = useRef<ProgramState | null>(null);
  const frameRef = useRef(0);
  const startedAtRef = useRef(performance.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });

    if (!gl) {
      setError('WebGL2 unavailable');
      return;
    }

    glRef.current = gl;
    vaoRef.current = gl.createVertexArray();
    gl.bindVertexArray(vaoRef.current);

    let animationFrame = 0;
    const render = () => {
      resizeCanvasToDisplaySize(canvas, gl);
      const program = programRef.current;
      if (program) {
        gl.useProgram(program.program);
        gl.bindVertexArray(vaoRef.current);
        gl.uniform2f(program.uResolution, canvas.width, canvas.height);
        gl.uniform1f(program.uTime, (performance.now() - startedAtRef.current) / 1000);
        gl.uniform1i(program.uFrame, frameRef.current);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        frameRef.current = (frameRef.current + 1) | 0;
      } else {
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      animationFrame = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrame);
      if (programRef.current) {
        gl.deleteProgram(programRef.current.program);
        programRef.current = null;
      }
      if (vaoRef.current) {
        gl.deleteVertexArray(vaoRef.current);
        vaoRef.current = null;
      }
      glRef.current = null;
    };
  }, []);

  useEffect(() => {
    const gl = glRef.current;
    if (!gl || !fragmentShader) return;

    try {
      const nextProgram = createProgram(gl, fragmentShader);
      const previousProgram = programRef.current;
      programRef.current = {
        program: nextProgram,
        uResolution: gl.getUniformLocation(nextProgram, 'u_resolution'),
        uTime: gl.getUniformLocation(nextProgram, 'u_time'),
        uFrame: gl.getUniformLocation(nextProgram, 'u_frame'),
      };
      if (previousProgram) {
        gl.deleteProgram(previousProgram.program);
      }
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [fragmentShader]);

  return (
    <>
      <canvas ref={canvasRef} className="webgl-preview" aria-hidden="true" />
      {error ? <div className="webgl-error">{error}</div> : null}
    </>
  );
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

function createProgram(gl: WebGL2RenderingContext, fragmentSource: string): WebGLProgram {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
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
