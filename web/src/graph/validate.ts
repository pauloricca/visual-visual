import { getDefinition, nodeAcceptsInputLink, nodeHasInput, nodeHasOutput } from './nodeTypes';
import { expandGroups } from './subpatch';
import type { Patch, PatchLink, PatchNode, ValidationResult } from './types';

export function validatePatch(patch: Patch): ValidationResult {
  const expandedPatch = expandGroups(patch);
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodes = new Map<string, PatchNode>();

  for (const node of expandedPatch.nodes) {
    if (nodes.has(node.id)) {
      errors.push(`Duplicate node id "${node.id}".`);
    }
    nodes.set(node.id, node);
  }

  const outputs = expandedPatch.nodes.filter((node) => node.type === 'Output');
  if (outputs.length === 0) {
    errors.push('Patch needs one Output node.');
  }
  if (outputs.length > 1) {
    errors.push('Patch can only have one Output node in v1.');
  }

  const inputTargets = new Set<string>();
  for (const link of expandedPatch.links) {
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
    if (!nodeHasOutput(source, link.from.port)) {
      errors.push(`Node "${source.id}" has no output port "${link.from.port}".`);
    }
    if (!nodeHasInput(target, link.to.port)) {
      errors.push(`Node "${target.id}" has no input port "${link.to.port}".`);
    } else if (!nodeAcceptsInputLink(target, link.to.port)) {
      errors.push(`Node "${target.id}" input "${link.to.port}" only accepts scalar values.`);
    }
    if (link.mode !== undefined && link.mode !== 'set' && link.mode !== 'add' && link.mode !== 'multiply') {
      errors.push(`Link "${linkKey(link)}" has an unknown mode "${String(link.mode)}".`);
    }

    inputTargets.add(endpointKey(link.to));
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

export function findFeedbackLinks(patch: Patch): PatchLink[] {
  const nodes = new Map(patch.nodes.map((node) => [node.id, node]));
  const orderedNodes = [...patch.nodes].sort(compareNodesByPosition);
  const outgoing = new Map<string, PatchLink[]>();
  for (const node of patch.nodes) {
    outgoing.set(node.id, []);
  }
  for (const link of patch.links) {
    if (nodes.has(link.from.node) && nodes.has(link.to.node)) {
      outgoing.get(link.from.node)?.push(link);
    }
  }

  const feedback = new Map<string, PatchLink>();
  const state = new Map<string, 'visiting' | 'done'>();

  function visit(nodeId: string): void {
    if (state.get(nodeId) === 'done') {
      return;
    }

    state.set(nodeId, 'visiting');

    const links = [...(outgoing.get(nodeId) ?? [])].sort((a, b) =>
      compareNodesByPosition(nodes.get(a.to.node), nodes.get(b.to.node)),
    );
    for (const link of links) {
      const nextState = state.get(link.to.node);
      if (nextState === 'visiting') {
        feedback.set(linkKey(link), link);
        continue;
      }
      if (nextState !== 'done') {
        visit(link.to.node);
      }
    }

    state.set(nodeId, 'done');
  }

  for (const node of orderedNodes) {
    if (!state.has(node.id)) {
      visit(node.id);
    }
  }

  return patch.links.filter((link) => feedback.has(linkKey(link)));
}

export function linkKey(link: PatchLink): string {
  return `${link.from.node}:${link.from.port}->${link.to.node}:${link.to.port}`;
}

function compareNodesByPosition(left: PatchNode | undefined, right: PatchNode | undefined): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;

  const leftX = left.position?.x ?? 0;
  const rightX = right.position?.x ?? 0;
  if (leftX !== rightX) return leftX - rightX;

  const leftY = left.position?.y ?? 0;
  const rightY = right.position?.y ?? 0;
  if (leftY !== rightY) return leftY - rightY;

  return left.id.localeCompare(right.id);
}
