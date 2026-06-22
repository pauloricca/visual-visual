import type { Patch, PatchLink, PatchNode } from './types';

const GROUP_DEFAULT_NODE_PREFIX = '__group_default';

export function expandGroups(patch: Patch): Patch {
  const expanded = expandGroupNodes(patch, '');
  return {
    nodes: expanded.nodes,
    links: dedupePatchLinks(expanded.links),
  };
}

function expandGroupNodes(patch: Patch, prefix: string): Patch {
  const nodes: PatchNode[] = [];
  const links: PatchLink[] = [];

  for (const node of patch.nodes) {
    if (node.type !== 'Group' || !node.subpatch) {
      nodes.push(prefixNode(node, prefix));
      continue;
    }

    const groupPatch = expandGroupNodes(node.subpatch, `${prefix}${node.id}__`);
    const insNodes = groupPatch.nodes.filter((candidate) => candidate.type === 'Ins');
    const outsNodes = groupPatch.nodes.filter((candidate) => candidate.type === 'Outs');
    const boundaryNodeIds = new Set([...insNodes, ...outsNodes].map((candidate) => candidate.id));
    const inputLinks = patch.links.filter((link) => link.to.node === node.id);
    const outputLinks = patch.links.filter((link) => link.from.node === node.id);
    const innerLinksByInput = groupBy(groupPatch.links, (link) => link.from.node, boundaryNodeIds, insNodes);
    const innerLinksByOutput = groupBy(groupPatch.links, (link) => link.to.node, boundaryNodeIds, outsNodes);
    const prefixedGroupId = `${prefix}${node.id}`;

    nodes.push(...groupPatch.nodes.filter((candidate) => !boundaryNodeIds.has(candidate.id)));
    nodes.push(...defaultNodesForUnconnectedGroupInputs(node, prefixedGroupId, inputLinks, innerLinksByInput));
    links.push(...groupPatch.links.filter((link) => (
      !boundaryNodeIds.has(link.from.node) &&
      !boundaryNodeIds.has(link.to.node)
    )));

    for (const [port, innerLinks] of innerLinksByInput) {
      const externalLinks = inputLinks.filter((link) => link.to.port === port);
      if (externalLinks.length === 0) {
        const defaultNodeId = defaultNodeIdForGroupInput(prefixedGroupId, port);
        links.push(...innerLinks.map((innerLink) => ({
          from: { node: defaultNodeId, port: 'value' },
          to: innerLink.to,
        })));
        continue;
      }

      for (const externalLink of externalLinks) {
        for (const innerLink of innerLinks) {
          links.push({
            from: prefixEndpoint(externalLink.from, prefix),
            to: innerLink.to,
            weight: externalLink.weight,
            mode: externalLink.mode,
          });
        }
      }
    }

    for (const [port, innerLinks] of innerLinksByOutput) {
      const externalLinks = outputLinks.filter((link) => link.from.port === port);
      for (const innerLink of innerLinks) {
        for (const externalLink of externalLinks) {
          links.push({
            from: innerLink.from,
            to: prefixEndpoint(externalLink.to, prefix),
            weight: externalLink.weight,
            mode: externalLink.mode,
          });
        }
      }
    }
  }

  for (const link of patch.links) {
    const source = patch.nodes.find((node) => node.id === link.from.node);
    const target = patch.nodes.find((node) => node.id === link.to.node);
    if (source?.type === 'Group' || target?.type === 'Group') continue;

    links.push({
      from: prefixEndpoint(link.from, prefix),
      to: prefixEndpoint(link.to, prefix),
      weight: link.weight,
      mode: link.mode,
    });
  }

  return { nodes, links };
}

function defaultNodesForUnconnectedGroupInputs(
  groupNode: PatchNode,
  prefixedGroupId: string,
  inputLinks: PatchLink[],
  innerLinksByInput: Map<string, PatchLink[]>,
): PatchNode[] {
  return [...innerLinksByInput]
    .filter(([port]) => !inputLinks.some((link) => link.to.port === port))
    .map(([port]) => ({
      id: defaultNodeIdForGroupInput(prefixedGroupId, port),
      type: 'Constant',
      params: { value: groupNode.params[port] ?? 0 },
      position: groupNode.position,
    }));
}

function groupBy(
  links: PatchLink[],
  boundarySelector: (link: PatchLink) => string,
  boundaryNodeIds: Set<string>,
  boundaryNodes: PatchNode[],
): Map<string, PatchLink[]> {
  const boundaryPorts = new Map<string, Set<string>>();
  for (const node of boundaryNodes) {
    const ports = new Set([...(node.inputs ?? []), ...(node.outputs ?? [])].map((port) => port.name));
    boundaryPorts.set(node.id, ports);
  }

  const grouped = new Map<string, PatchLink[]>();
  for (const link of links) {
    const boundaryNode = boundarySelector(link);
    if (!boundaryNodeIds.has(boundaryNode)) continue;

    const port = link.from.node === boundaryNode ? link.from.port : link.to.port;
    if (!boundaryPorts.get(boundaryNode)?.has(port)) continue;

    grouped.set(port, [...(grouped.get(port) ?? []), link]);
  }

  return grouped;
}

function prefixNode(node: PatchNode, prefix: string): PatchNode {
  if (!prefix) return cloneNode(node);

  return {
    ...cloneNode(node),
    id: `${prefix}${node.id}`,
  };
}

function cloneNode(node: PatchNode): PatchNode {
  return {
    id: node.id,
    type: node.type,
    ...(node.subpatchName ? { subpatchName: node.subpatchName } : {}),
    ...(node.subpatchCloneId ? { subpatchCloneId: node.subpatchCloneId } : {}),
    params: { ...node.params },
    ...(node.position ? { position: { ...node.position } } : {}),
    ...(node.inputs ? { inputs: node.inputs.map((port) => ({ ...port })) } : {}),
    ...(node.outputs ? { outputs: node.outputs.map((port) => ({ ...port })) } : {}),
    ...(node.subpatch ? { subpatch: clonePatch(node.subpatch) } : {}),
  };
}

function clonePatch(patch: Patch): Patch {
  return {
    nodes: patch.nodes.map(cloneNode),
    links: patch.links.map((link) => ({
      from: { ...link.from },
      to: { ...link.to },
      weight: link.weight,
      mode: link.mode,
    })),
  };
}

function prefixEndpoint(endpoint: PatchLink['from'], prefix: string): PatchLink['from'] {
  return {
    node: `${prefix}${endpoint.node}`,
    port: endpoint.port,
  };
}

function defaultNodeIdForGroupInput(groupId: string, port: string): string {
  return `${GROUP_DEFAULT_NODE_PREFIX}_${groupId}_${port}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

function dedupePatchLinks(links: PatchLink[]): PatchLink[] {
  const seen = new Set<string>();
  const deduped: PatchLink[] = [];

  for (const link of links) {
    const key = `${link.from.node}:${link.from.port}->${link.to.node}:${link.to.port}`;
    if (seen.has(key)) continue;

    seen.add(key);
    deduped.push(link);
  }

  return deduped;
}
