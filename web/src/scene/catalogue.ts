import {
  NodeRegistry,
  emptyGraph,
  type GraphDocument,
  type NodeDefinition,
  type PortDefinition,
} from "@pauloricca/spagbol";
import { extractExpressionInputs } from "../graph/expression";

const transform = {
  positionX: 0,
  positionY: 0,
  positionZ: 0,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
};
const material = {
  colourR: 1,
  colourG: 1,
  colourB: 1,
  roughness: 0.5,
  metalness: 0,
  opacity: 1,
  emissiveR: 0,
  emissiveG: 0,
  emissiveB: 0,
  emissiveIntensity: 1,
};
const light = { colourR: 1, colourG: 1, colourB: 1, intensity: 1 };
const shadow = {
  shadowStrength: 1,
  shadowSoftness: 2,
  shadowBias: -0.0001,
  shadowNormalBias: 0.02,
  shadowNear: 0.5,
  shadowFar: 500,
};
const camera = {
  positionX: 0,
  positionY: 0,
  positionZ: 5,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  near: 0.1,
  far: 1000,
};
export const entityDefaults: Record<string, Record<string, number>> = {
  Plane: { width: 2, height: 2, ...transform, ...material },
  Box: { width: 1, height: 1, depth: 1, ...transform, ...material },
  Sphere: { radius: 1, ...transform, ...material },
  Cylinder: {
    topRadius: 1,
    bottomRadius: 1,
    height: 2,
    ...transform,
    ...material,
  },
  Mesh: { ...transform, ...material },
  Painty: { size: 2, ...transform, opacity: 1 },
  Image: { width: 2, height: 2, ...transform, opacity: 1 },
  Video: {
    width: 2,
    height: 2,
    ...transform,
    opacity: 1,
    speed: 1,
    playing: 1,
  },
  Text: {
    size: 1,
    ...transform,
    colourR: 1,
    colourG: 1,
    colourB: 1,
    opacity: 1,
  },
  "Perspective Camera": { ...camera, fov: 50 },
  "Orthographic Camera": { ...camera, size: 5 },
  "Ambient Light": { ...light },
  "Directional Light": {
    ...light,
    ...shadow,
    shadowSize: 10,
    rotationX: -0.7,
    rotationY: -0.5,
    rotationZ: 0,
  },
  "Point Light": {
    ...light,
    ...shadow,
    positionX: 2,
    positionY: 2,
    positionZ: 2,
    range: 0,
  },
  "Spot Light": {
    ...light,
    ...shadow,
    ...transform,
    positionY: 3,
    coneAngle: 0.5,
    range: 0,
  },
  Background: { colourR: 0.02, colourG: 0.02, colourB: 0.025, rotation: 0 },
  Fog: {
    colourR: 0.1,
    colourG: 0.1,
    colourB: 0.1,
    density: 0.05,
    near: 1,
    far: 30,
  },
  "Environment Map": { intensity: 1, rotation: 0 },
  "Render Settings": { exposure: 1, shadows: 1 },
};
const generic: Record<string, Record<string, number>> = {
  Expression: {},
  Constant: { value: 1 },
  Pass: { value: 0 },
  Abs: { value: 0 },
  Multiply: { a: 0, b: 1 },
  Pow: { base: 1, exponent: 1 },
  Map: { value: 0, inMin: 0, inMax: 1, outMin: 0, outMax: 1 },
  Clamp: { value: 0, min: 0, max: 1 },
  Selector: { select: 0, slide: 0, a: 0, b: 1 },
  "Conditional Execution": { gate: 0 },
  Spread: { count: 1 },
  Spawn: { trigger: 0, release: 0, lifetime: 0, limit: 100 },
  Accumulator: { trigger: 0, reset: 0, increment: 1, min: 0, max: 1 },
  Random: { seed: 1, trigger: 0, min: -1, max: 1 },
  Noise: { min: -1, max: 1 },
  Slider: { value: 0.5, min: 0, max: 1 },
  Button: { value: 0 },
  Joystick: { x: 0.5, y: 0.5, xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
  Curve: { position: 0 },
  Sequence: { position: 0 },
  Instance: { kill: 0 },
  "Scene Time": {},
  "Scene Playhead": { speed: 1, length: 10, loop: 1, reset: 0, playing: 1 },
};
export const scopeKinds = ["Spread", "Spawn", "Conditional Execution"];
export const sceneDefinitions: NodeDefinition[] = Object.entries({
  ...entityDefaults,
  ...generic,
}).map(([kind, defaults]) => ({
  kind,
  label: kind,
  category: kind in entityDefaults ? "Scene" : "Modulation",
  createData: () => ({
    ...(kind === "Expression" ? { expression: "a" } : {}),
    ...(kind === "Curve"
      ? {
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
          ],
          boundary: "clamp",
        }
      : {}),
    ...(kind === "Sequence" ? { items: [], steps: 16, boundary: "clamp" } : {}),
    ...(kind === "Accumulator" ? { mode: "trigger" } : {}),
    ...(kind === "Text" ? { text: "Visual Visual", font: "sans-serif" } : {}),
  }),
  ...(scopeKinds.includes(kind) ? { createGraph: emptyGraph } : {}),
  ports: (node) => {
    const inputs =
      kind === "Expression"
        ? Object.fromEntries(
            extractExpressionInputs(String(node.data.expression ?? "a")).map(
              (id) => [id, 0],
            ),
          )
        : defaults;
    const outputs =
      kind in entityDefaults
        ? []
        : kind === "Instance"
          ? ["index", "count", "age", "gate"]
          : kind === "Scene Time"
            ? ["seconds", "delta"]
            : kind === "Joystick"
              ? ["x", "y"]
              : scopeKinds.includes(kind)
                ? ["index", "count", "age", "gate"]
                : ["value"];
    return [
      ...Object.entries(inputs).map(([id, defaultValue]): PortDefinition => ({
        id,
        label: id,
        direction: "input",
        defaultValue,
      })),
      ...outputs.map((id): PortDefinition => ({
        id,
        label: id,
        direction: "output",
      })),
    ];
  },
}));
export const sceneNodes = new NodeRegistry(sceneDefinitions);
export const emptyScene = (): GraphDocument => emptyGraph();
