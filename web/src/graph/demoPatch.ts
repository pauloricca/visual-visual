import type { Patch } from './types';

export const demoPatch: Patch = {
  nodes: [
    { id: 'system_1', type: 'System', params: {}, position: { x: 40, y: 160 } },
    {
      id: 'multiply_1',
      type: 'Multiply',
      params: { a: 0, b: 80 },
      position: { x: 300, y: 80 },
    },
    {
      id: 'sin_1',
      type: 'Sin',
      params: { value: 0 },
      position: { x: 520, y: 80 },
    },
    {
      id: 'multiply_2',
      type: 'Multiply',
      params: { a: 0, b: 40 },
      position: { x: 300, y: 260 },
    },
    {
      id: 'sin_2',
      type: 'Sin',
      params: { value: 0 },
      position: { x: 520, y: 260 },
    },
    {
      id: 'sin_3',
      type: 'Sin',
      params: { value: 0 },
      position: { x: 520, y: 440 },
    },
    { id: 'output_1', type: 'Output', params: { r: 0, g: 0, b: 0 }, position: { x: 760, y: 210 } },
  ],
  links: [
    { from: { node: 'system_1', port: 'x' }, to: { node: 'multiply_1', port: 'a' } },
    { from: { node: 'multiply_1', port: 'value' }, to: { node: 'sin_1', port: 'value' } },
    { from: { node: 'sin_1', port: 'value' }, to: { node: 'output_1', port: 'r' } },
    { from: { node: 'system_1', port: 'y' }, to: { node: 'multiply_2', port: 'a' } },
    { from: { node: 'multiply_2', port: 'value' }, to: { node: 'sin_2', port: 'value' } },
    { from: { node: 'sin_2', port: 'value' }, to: { node: 'output_1', port: 'g' } },
    { from: { node: 'system_1', port: 'time' }, to: { node: 'sin_3', port: 'value' } },
    { from: { node: 'sin_3', port: 'value' }, to: { node: 'output_1', port: 'b' } },
  ],
};
