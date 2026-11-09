import {
  NodeRegistry,
  assertDocument,
  portsFor,
  effectiveGroupGraph,
  spagbolGroupKinds,
  type GraphDocument,
  type GraphNode,
  type PortDefinition as GraphPort,
  type NodeData,
} from "@pauloricca/spagbol";
import {
  getDefinition,
  getNodeTypeLabel,
  NODE_TYPE_LIST,
} from "../graph/nodeTypes";
import { extractExpressionInputs } from "../graph/expression";
import { parsePatchJson } from "../graph/parse";
import type {
  Patch,
  PatchNode,
  NodeType,
  PortDefinition,
  PatchLink,
} from "../graph/types";

const kinds = {
  Group: spagbolGroupKinds.group,
  Ins: spagbolGroupKinds.inputs,
  Outs: spagbolGroupKinds.outputs,
};
export function nodeKind(type: NodeType): string {
  return kinds[type as keyof typeof kinds] ?? type;
}
function patchType(kind: string): NodeType {
  return (Object.entries(kinds).find(([, value]) => value === kind)?.[0] ??
    kind) as NodeType;
}
function ports(
  ports: PortDefinition[],
  direction: "input" | "output",
): GraphPort[] {
  return ports.map(({ name, ...port }) => ({
    ...port,
    id: name,
    label: name,
    direction,
  }));
}
export const shaderNodes = new NodeRegistry(
  NODE_TYPE_LIST.filter((type) => !["Group", "Ins", "Outs"].includes(type)).map(
    (type) => ({
      kind: type,
      label: getNodeTypeLabel(type),
      createData: (): NodeData =>
        type === "Expression" ? { expression: "a" } : {},
      ports: (node: GraphNode) =>
        type === "Expression"
          ? [
              ...ports(
                extractExpressionInputs(
                  String(node.data.expression ?? "a"),
                ).map((name) => ({ name, defaultValue: 0 })),
                "input",
              ),
              ...ports(getDefinition(type).outputs, "output"),
            ]
          : [
              ...ports(getDefinition(type).inputs, "input"),
              ...ports(getDefinition(type).outputs, "output"),
            ],
    }),
  ),
);

export function patchToGraph(patch: Patch): GraphDocument {
  return {
    format: "spagbol",
    version: 1,
    areas: [],
    data: { name: patch.name ?? "" },
    nodes: patch.nodes.map(
      ({
        id,
        type,
        params,
        position,
        subpatch,
        subpatchName,
        subpatchCloneId,
        inputs,
        outputs,
        expression,
      }) => {
        const dynamic = ["Group", "Ins", "Outs"].includes(type);
        return {
          id,
          kind: nodeKind(type),
          position: position ?? { x: 0, y: 0 },
          values: { ...params },
          data: {
            ...(expression !== undefined ? { expression } : {}),
            ...(subpatchName ? { subpatchName } : {}),
          },
          ...(subpatchName ? { label: subpatchName } : {}),
          ...(subpatchCloneId ? { sharedGraphId: subpatchCloneId } : {}),
          ...(dynamic
            ? {
                ports: [
                  ...ports(inputs ?? [], "input"),
                  ...ports(outputs ?? [], "output"),
                ],
              }
            : {}),
          ...(subpatch
            ? {
                graph: {
                  ...patchToGraph(subpatch),
                  data: { name: subpatchName ?? subpatch.name ?? "" },
                },
              }
            : {}),
        };
      },
    ),
    links: patch.links.map((link, index) => ({
      id: `link-${index}`,
      source: { nodeId: link.from.node, portId: link.from.port },
      target: {
        type: "port" as const,
        nodeId: link.to.node,
        portId: link.to.port,
      },
      mode: link.mode ?? "set",
      weight: link.weight ?? 1,
    })),
  };
}
function patchPorts(
  node: GraphNode,
  direction: "input" | "output",
): PortDefinition[] {
  return (node.ports ?? [])
    .filter((port) => port.direction === direction)
    .map(({ label, defaultValue, min, max, integer, connectable }) => ({
      name: label,
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(integer !== undefined ? { integer } : {}),
      ...(connectable !== undefined ? { connectable } : {}),
    }));
}
const portNamesCache = new WeakMap<GraphNode, Map<string, string>>();
function portNames(node: GraphNode) {
  let names = portNamesCache.get(node);
  if (!names) {
    names = new Map(
      portsFor(node, shaderNodes).map((port) => [
        `${port.direction}:${port.id}`,
        port.label,
      ]),
    );
    portNamesCache.set(node, names);
  }
  return names;
}
// Translate stable group port IDs back into the legacy patch's human-readable names.
export function graphToPatch(graph: GraphDocument): Patch {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const portName = (
    nodeId: string,
    portId: string,
    direction: "input" | "output",
  ) => {
    const node = nodes.get(nodeId);
    return (node && portNames(node).get(`${direction}:${portId}`)) || portId;
  };
  return {
    ...(graph.data?.name ? { name: String(graph.data.name) } : {}),
    nodes: graph.nodes.map((node): PatchNode => {
      const type = patchType(node.kind);
      return {
        id: node.id,
        type,
        params: Object.fromEntries(
          Object.entries(node.values).map(([id, value]) => [
            portName(node.id, id, type === "Ins" ? "output" : "input"),
            value,
          ]),
        ),
        position: { ...node.position },
        ...(node.data.expression !== undefined
          ? {
              expression: String(node.data.expression),
              inputs: extractExpressionInputs(String(node.data.expression)).map(
                (name) => ({ name, defaultValue: 0 }),
              ),
            }
          : {}),
        ...(["Group", "Ins", "Outs"].includes(type)
          ? {
              inputs: patchPorts(node, "input"),
              outputs: patchPorts(node, "output"),
            }
          : {}),
        ...(node.label || node.data.subpatchName
          ? { subpatchName: node.label ?? String(node.data.subpatchName) }
          : {}),
        ...(node.sharedGraphId ? { subpatchCloneId: node.sharedGraphId } : {}),
        ...(node.graph
          ? { subpatch: graphToPatch(effectiveGroupGraph(node)!) }
          : {}),
      };
    }),
    links: graph.links.flatMap((link) =>
      link.target.type === "port" && link.enabled !== false
        ? [
            {
              from: {
                node: link.source.nodeId,
                port: portName(
                  link.source.nodeId,
                  link.source.portId,
                  "output",
                ),
              },
              to: {
                node: link.target.nodeId,
                port: portName(link.target.nodeId, link.target.portId, "input"),
              },
              weight: link.weight,
              mode: link.mode as "set" | "add" | "multiply",
            },
          ]
        : [],
    ),
  };
}

export interface EditorUi {
  patchName?: string;
  visualizationVisible?: boolean;
  sidePanelOpen?: boolean;
  viewport?: { x: number; y: number; zoom: number };
}
export const STORAGE_KEY = "visual-visual.editor-state.v2";
export function readEditorState(): {
  document: GraphDocument;
  ui?: EditorUi;
} | null {
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current) {
      try {
        const state = JSON.parse(current);
        assertDocument(state.document);
        normalizeShaderDocument(state.document, state.document);
        return state;
      } catch {
        /* Fall back to the untouched v1 state. */
      }
    }
    const raw = localStorage.getItem("visual-visual.editor-state.v1");
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (
      state.version !== 1 ||
      !Array.isArray(state.nodes) ||
      !Array.isArray(state.edges)
    )
      return null;
    // Old typeless nodes are wire passthroughs. Resolve them before replacing the old graph controller.
    const typedIds = new Set(
      state.nodes
        .filter((n: { type: string | null }) => n.type)
        .map((n: { id: string }) => n.id),
    );
    const links: PatchLink[] = state.edges.flatMap(
      (e: {
        source: string;
        target: string;
        sourceHandle: string;
        targetHandle: string;
        weight?: number;
        mode?: PatchLink["mode"];
      }): PatchLink[] => {
        const forward =
          e.sourceHandle?.startsWith("out:") &&
          e.targetHandle?.startsWith("in:");
        const reverse =
          e.sourceHandle?.startsWith("in:") &&
          e.targetHandle?.startsWith("out:");
        if (!forward && !reverse) return [];
        return [
          {
            from: forward
              ? { node: e.source, port: e.sourceHandle.slice(4) }
              : { node: e.target, port: e.targetHandle.slice(4) },
            to: forward
              ? { node: e.target, port: e.targetHandle.slice(3) }
              : { node: e.source, port: e.sourceHandle.slice(3) },
            weight: e.weight,
            mode: e.mode,
          },
        ];
      },
    );
    const resolve = (id: string, seen = new Set<string>()): typeof links => {
      if (seen.has(id)) return [];
      const next = new Set([...seen, id]);
      return links
        .filter((l) => l.from.node === id)
        .flatMap((l) =>
          typedIds.has(l.to.node) ? [l] : resolve(l.to.node, next),
        );
    };
    const patch = parsePatchJson(
      JSON.stringify({
        nodes: state.nodes.filter((n: { type: string | null }) => n.type),
        links: links
          .filter((l) => typedIds.has(l.from.node))
          .flatMap((l) =>
            typedIds.has(l.to.node)
              ? [l]
              : resolve(l.to.node)
                  .filter((r) => r.to.node !== l.from.node)
                  .map((r: PatchLink) => ({ ...r, from: l.from })),
          ),
      }),
    );
    return { document: patchToGraph(patch), ui: state.ui };
  } catch {
    return null;
  }
}

// The shader patch contract has no node/link enabled state. Keep unsupported core toggles
// inert instead of allowing a visual mute that leaves the shader running.
export function normalizeShaderDocument(
  document: GraphDocument,
  previous: GraphDocument,
): void {
  for (const node of document.nodes) {
    delete node.enabled;
    if (node.graph) {
      const before = previous.nodes.find((item) => item.id === node.id);
      if (
        node.graph.data?.name !== before?.graph?.data?.name &&
        typeof node.graph.data?.name === "string"
      )
        node.label = node.graph.data.name;
      normalizeShaderDocument(node.graph, before?.graph ?? node.graph);
    }
  }
  for (const link of document.links) delete link.enabled;
}
