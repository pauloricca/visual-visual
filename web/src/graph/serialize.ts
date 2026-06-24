import type { Patch } from './types';

export function normalizePatch(patch: Patch): Patch {
  return {
    ...(patch.name ? { name: patch.name } : {}),
    nodes: [...patch.nodes]
      .map((node) => ({
        id: node.id,
        type: node.type,
        ...(node.subpatchName ? { subpatchName: node.subpatchName } : {}),
        ...(node.subpatchCloneId ? { subpatchCloneId: node.subpatchCloneId } : {}),
        ...(node.expression !== undefined ? { expression: node.expression } : {}),
        params: sortRecord(node.params),
        ...(node.position ? { position: node.position } : {}),
        ...(node.inputs ? { inputs: node.inputs.map((input) => ({ ...input })) } : {}),
        ...(node.outputs ? { outputs: node.outputs.map((output) => ({ ...output })) } : {}),
        ...(node.subpatch ? { subpatch: normalizePatch(node.subpatch) } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    links: [...patch.links].sort(compareLinks),
  };
}

export function patchToJson(patch: Patch): string {
  return `${JSON.stringify(normalizePatch(patch), null, 2)}\n`;
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function compareLinks(a: Patch['links'][number], b: Patch['links'][number]): number {
  return (
    a.to.node.localeCompare(b.to.node) ||
    a.to.port.localeCompare(b.to.port) ||
    a.from.node.localeCompare(b.from.node) ||
    a.from.port.localeCompare(b.from.port)
  );
}
