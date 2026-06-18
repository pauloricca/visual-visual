import type { NodeDefinition, NodeType } from './types';

export const NODE_DEFINITIONS: Record<NodeType, NodeDefinition> = {
  System: {
    type: 'System',
    inputs: [],
    outputs: [
      { name: 'x' },
      { name: 'y' },
      { name: 'time' },
      { name: 'frame' },
      { name: 'mic' },
    ],
  },
  Output: {
    type: 'Output',
    inputs: [
      { name: 'r', defaultValue: 0 },
      { name: 'g', defaultValue: 0 },
      { name: 'b', defaultValue: 0 },
    ],
    outputs: [],
  },
  Constant: {
    type: 'Constant',
    inputs: [{ name: 'value', defaultValue: 1 }],
    outputs: [{ name: 'value' }],
  },
  Add: binary('Add', 0, 0),
  Subtract: binary('Subtract', 0, 0),
  Multiply: binary('Multiply', 0, 1),
  Divide: binary('Divide', 0, 1),
  Mod: binary('Mod', 0, 1),
  Sin: unary('Sin'),
  Cos: unary('Cos'),
  Abs: unary('Abs'),
  Floor: unary('Floor'),
  Fract: unary('Fract'),
  Step: {
    type: 'Step',
    inputs: [
      { name: 'edge', defaultValue: 0.5 },
      { name: 'value', defaultValue: 0 },
    ],
    outputs: [{ name: 'value' }],
  },
  Smoothstep: {
    type: 'Smoothstep',
    inputs: [
      { name: 'edge0', defaultValue: 0 },
      { name: 'edge1', defaultValue: 1 },
      { name: 'value', defaultValue: 0 },
    ],
    outputs: [{ name: 'value' }],
  },
  Mix: {
    type: 'Mix',
    inputs: [
      { name: 'a', defaultValue: 0 },
      { name: 'b', defaultValue: 1 },
      { name: 'amount', defaultValue: 0.5 },
    ],
    outputs: [{ name: 'value' }],
  },
  Min: binary('Min', 0, 1),
  Max: binary('Max', 0, 1),
  Clamp: {
    type: 'Clamp',
    inputs: [
      { name: 'value', defaultValue: 0 },
      { name: 'min', defaultValue: 0 },
      { name: 'max', defaultValue: 1 },
    ],
    outputs: [{ name: 'value' }],
  },
  Noise: {
    type: 'Noise',
    inputs: [
      { name: 'x', defaultValue: 0 },
      { name: 'y', defaultValue: 0 },
      { name: 'scale', defaultValue: 12 },
      { name: 'seed', defaultValue: 0 },
    ],
    outputs: [{ name: 'value' }],
  },
  Delay: {
    type: 'Delay',
    inputs: [
      { name: 'value', defaultValue: 0 },
      { name: 'frames', defaultValue: 1, connectable: false },
    ],
    outputs: [{ name: 'value' }],
  },
  Envelope: {
    type: 'Envelope',
    inputs: [
      { name: 'value', defaultValue: 0 },
      { name: 'attack', defaultValue: 4 },
      { name: 'release', defaultValue: 16 },
    ],
    outputs: [{ name: 'value' }],
  },
  Camera: {
    type: 'Camera',
    inputs: [
      { name: 'x', defaultValue: 0 },
      { name: 'y', defaultValue: 0 },
    ],
    outputs: [
      { name: 'r' },
      { name: 'g' },
      { name: 'b' },
    ],
  },
};

export const NODE_TYPE_LIST = Object.keys(NODE_DEFINITIONS) as NodeType[];

export function getDefinition(type: NodeType): NodeDefinition {
  return NODE_DEFINITIONS[type];
}

export function hasInput(type: NodeType, port: string): boolean {
  return NODE_DEFINITIONS[type].inputs.some((input) => input.name === port);
}

export function acceptsInputLink(type: NodeType, port: string): boolean {
  return NODE_DEFINITIONS[type].inputs.some((input) => (
    input.name === port &&
    input.connectable !== false
  ));
}

export function hasOutput(type: NodeType, port: string): boolean {
  return NODE_DEFINITIONS[type].outputs.some((output) => output.name === port);
}

export function defaultParamsFor(type: NodeType): Record<string, number> {
  return Object.fromEntries(
    NODE_DEFINITIONS[type].inputs.map((input) => [
      input.name,
      input.defaultValue ?? 0,
    ]),
  );
}

function unary(type: NodeType): NodeDefinition {
  return {
    type,
    inputs: [{ name: 'value', defaultValue: 0 }],
    outputs: [{ name: 'value' }],
  };
}

function binary(type: NodeType, a: number, b: number): NodeDefinition {
  return {
    type,
    inputs: [
      { name: 'a', defaultValue: a },
      { name: 'b', defaultValue: b },
    ],
    outputs: [{ name: 'value' }],
  };
}
