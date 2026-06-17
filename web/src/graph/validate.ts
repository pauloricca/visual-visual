import { getDefinition, hasInput, hasOutput } from './nodeTypes';
import type { Patch, PatchLink, PatchNode, ValidationResult } from './types';

export function validatePatch(patch: Patch): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodes = new Map<string, PatchNode>();

  for (const node of patch.nodes) {
    if (nodes.has(node.id)) {
      errors.push(`Duplicate node id "${node.id}".`);
    }
    nodes.set(node.id, node);
  }

  const outputs = patch.nodes.filter((node) => node.type === 'Output');
  if (outputs.length === 0) {
    errors.push('Patch needs one Output node.');
  }
  if (outputs.length > 1) {
    errors.push('Patch can only have one Output node in v1.');
  }

  const inputTargets = new Set<string>();
  for (const link of patch.links) {
    const source = nodes.get(link.from.node);
    const target = nodes.get(link.to.node);
    if (!source) {
      errors.push(`Link source node "${link.from.node}" does not exist.`);
      continue;
    }
    if (!target) {
      errors.push(`Link target node "${link.to.node}" does not exist.`);
      continue;
    }
    if (!hasOutput(source.type, link.from.port)) {
      errors.push(`Node "${source.id}" has no output port "${link.from.port}".`);
    }
    if (!hasInput(target.type, link.to.port)) {
      errors.push(`Node "${target.id}" has no input port "${link.to.port}".`);
    }

    inputTargets.add(endpointKey(link.to));
  }

  const cycle = findCycle(patch, nodes);
  if (cycle) {
    errors.push(`Graph contains a cycle: ${cycle.join(' -> ')}.`);
  }

  const output = outputs[0];
  if (output) {
    for (const port of getDefinition('Output').inputs) {
      if (!inputTargets.has(`${output.id}.${port.name}`)) {
        warnings.push(`Output.${port.name} is unconnected and will use ${output.params[port.name] ?? port.defaultValue ?? 0}.`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function endpointKey(endpoint: { node: string; port: string }): string {
  return `${endpoint.node}.${endpoint.port}`;
}

export function incomingLinksByInput(links: PatchLink[]): Map<string, PatchLink[]> {
  const incoming = new Map<string, PatchLink[]>();
  for (const link of links) {
    const key = endpointKey(link.to);
    incoming.set(key, [...(incoming.get(key) ?? []), link]);
  }
  return incoming;
}

function findCycle(patch: Patch, nodes: Map<string, PatchNode>): string[] | null {
  const edges = new Map<string, string[]>();
  for (const node of patch.nodes) {
    edges.set(node.id, []);
  }
  for (const link of patch.links) {
    if (nodes.has(link.from.node) && nodes.has(link.to.node)) {
      edges.get(link.from.node)?.push(link.to.node);
    }
  }

  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  function visit(nodeId: string): string[] | null {
    if (state.get(nodeId) === 'visiting') {
      const start = stack.indexOf(nodeId);
      return [...stack.slice(start), nodeId];
    }
    if (state.get(nodeId) === 'done') {
      return null;
    }
    state.set(nodeId, 'visiting');
    stack.push(nodeId);
    for (const next of edges.get(nodeId) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(nodeId, 'done');
    return null;
  }

  for (const node of patch.nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle;
  }
  return null;
}
