import type { GraphDocument, GraphLink, GraphNode } from "@pauloricca/spagbol";

// Express saved offset samplers with ordinary coordinate links, keeping their image intact.
export function migrateSceneRenderNodes(graph: GraphDocument): void {
  const usedIds = new Set([...graph.nodes, ...graph.links].map((item) => item.id));
  const uniqueId = (base: string) => {
    let id = base, suffix = 2;
    while (usedIds.has(id)) id = `${base}-${suffix++}`;
    usedIds.add(id);
    return id;
  };
  const connect = (source: GraphNode, portId: string, target: GraphNode, input: string) => {
    graph.links.push({
      id: uniqueId(`${target.id}-${input}`),
      source: { nodeId: source.id, portId },
      target: { type: "port", nodeId: target.id, portId: input },
      mode: "set", weight: 1,
    });
  };
  for (const node of [...graph.nodes]) {
    if (node.graph) migrateSceneRenderNodes(node.graph);
    if (node.kind !== "Scene Render") continue;
    let system = graph.nodes.find((item) => item.kind === "System");
    if (!system) {
      system = {
        id: uniqueId(`${node.id}-coordinates`), kind: "System",
        position: { x: node.position.x - 500, y: node.position.y },
        values: {}, data: {},
      };
      graph.nodes.push(system);
    }
    for (const [axis, offset] of [["x", "offsetX"], ["y", "offsetY"]] as const) {
      const incoming = graph.links.filter((link): link is GraphLink & {
        target: { type: "port"; nodeId: string; portId: string };
      } => link.target.type === "port" && link.target.nodeId === node.id && link.target.portId === offset);
      if (incoming.length || node.values[offset]) {
        const add: GraphNode = {
          id: uniqueId(`${node.id}-${axis}`), kind: "Add",
          position: { x: node.position.x - 250, y: node.position.y + (axis === "y" ? 170 : 0) },
          values: { a: 0, b: node.values[offset] ?? 0 }, data: {},
        };
        graph.nodes.push(add);
        for (const link of incoming) link.target = { type: "port", nodeId: add.id, portId: "b" };
        connect(system, axis, add, "a");
        connect(add, "value", node, axis);
      } else connect(system, axis, node, axis);
    }
    node.kind = "Scene";
    node.values = { x: 0, y: 0 };
    if (node.label === "Scene Render") delete node.label;
    if (node.ports) delete node.ports;
  }
}
