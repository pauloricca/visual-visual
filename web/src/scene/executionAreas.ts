import { areaMembers, emptyGraph, type GraphDocument } from '@pauloricca/spagbol';
import { scopeKinds } from './catalogue';

// Execution owners remain numeric nodes; Spagbol owns their bounds and membership.
export function normalizeExecutionAreas(graph: GraphDocument, previous?: GraphDocument): void {
  const removed = new Set<string>();
  const removedAreas = new Set<string>();
  for (const area of previous?.areas ?? []) {
    if (!area.ownerNodeId || graph.nodes.some(n => n.id === area.ownerNodeId)) continue;
    const members = areaMembers(previous!, area.id);
    for (const id of members.nodeIds) removed.add(id);
    for (const id of members.areaIds) removedAreas.add(id);
    removedAreas.add(area.id);
  }
  if (removed.size) {
    graph.nodes = graph.nodes.filter(n => !removed.has(n.id));
    graph.areas = graph.areas.filter(a => !removedAreas.has(a.id));
    graph.links = graph.links.filter(l => !removed.has(l.source.nodeId) && (l.target.type !== 'port' || !removed.has(l.target.nodeId)));
    const links = new Set(graph.links.map(l => l.id));
    graph.links = graph.links.filter(l => l.target.type !== 'link' || links.has(l.target.linkId));
  }
  for (const node of [...graph.nodes]) {
    if (!scopeKinds.includes(node.kind)) {
      if (node.graph) normalizeExecutionAreas(node.graph);
      continue;
    }
    if (graph.areas.some(a => a.ownerNodeId === node.id)) continue;
    const child = node.graph ?? emptyGraph();
    normalizeExecutionAreas(child);
    const offset = { x: node.position.x, y: node.position.y + 300 };
    const ids = new Map(child.nodes.map(n => [n.id, `${node.id}__${n.id}`]));
    const remap = (id: string) => ids.get(id) ?? id;
    const members = child.nodes.map(n => ({ ...n, id: remap(n.id), position: { x: n.position.x + offset.x, y: n.position.y + offset.y } }));
    graph.nodes.push(...members);
    graph.links.push(...child.links.map(l => ({ ...l, id: `${node.id}__${l.id}`, source: { ...l.source, nodeId: remap(l.source.nodeId) }, target: l.target.type === 'port' ? { ...l.target, nodeId: remap(l.target.nodeId) } : { ...l.target, linkId: `${node.id}__${l.target.linkId}` } })));
    graph.areas.push(...child.areas.map(a => ({ ...a, id: `${node.id}__${a.id}`, ownerNodeId: a.ownerNodeId ? remap(a.ownerNodeId) : undefined, nodeIds: a.nodeIds?.map(remap), areaIds: a.areaIds?.map(id => `${node.id}__${id}`), position: { x: a.position.x + offset.x, y: a.position.y + offset.y } })));
    delete node.graph;
    const position = { x: node.position.x - 16, y: node.position.y - 42 };
    graph.areas.push({ id: `execution-${node.id}`, ownerNodeId: node.id, title: node.label ?? node.kind, position, size: { width: Math.max(420, ...members.map(n => n.position.x - position.x + (n.size?.width ?? 240) + 24), ...child.areas.map(a => a.position.x + offset.x - position.x + a.size.width + 24)), height: Math.max(480, ...members.map(n => n.position.y - position.y + (n.size?.height ?? 180) + 24), ...child.areas.map(a => a.position.y + offset.y - position.y + a.size.height + 24)) }, controlHeight: 300, locked: false, nodeIds: [node.id, ...members.map(n => n.id)], areaIds: child.areas.map(a => `${node.id}__${a.id}`) });
  }
}

const cache = new WeakMap<GraphDocument, GraphDocument>();
// Project visual membership into the existing execution model without changing saved data.
export function executionGraph(graph: GraphDocument): GraphDocument {
  const cached = cache.get(graph);
  if (cached) return cached;
  const owners = graph.areas.filter(a => a.ownerNodeId && graph.nodes.some(n => n.id === a.ownerNodeId));
  if (!owners.length) return graph;
  const sets = new Map(owners.map(a => [a.id, areaMembers(graph, a.id).nodeIds]));
  const parent = new Map<string, string>();
  for (const node of graph.nodes) {
    const candidates = owners.filter(a => a.ownerNodeId !== node.id && sets.get(a.id)!.has(node.id));
    candidates.sort((a,b) => sets.get(a.id)!.size - sets.get(b.id)!.size || a.id.localeCompare(b.id));
    if (candidates.length) parent.set(node.id, candidates[0].ownerNodeId!);
  }
  const build = (owner?: string, visiting = new Set<string>()): GraphDocument => ({ ...graph, areas: [], nodes: graph.nodes.filter(n => parent.get(n.id) === owner).map(n => {
    if (!owners.some(a => a.ownerNodeId === n.id) || visiting.has(n.id)) return n;
    return { ...n, graph: build(n.id, new Set([...visiting, n.id])) };
  }), links: graph.links.filter(l => l.target.type === 'port' ? parent.get(l.target.nodeId) === owner : true) });
  const result = build();
  if (Object.isFrozen(graph)) cache.set(graph, result);
  return result;
}
