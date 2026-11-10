import { assertDocument, type GraphDocument } from "@pauloricca/spagbol";
import { parsePatchJson } from "../graph/parse";
import { patchToGraph } from "../editor/patchCodec";
import { migrateSceneRenderNodes } from "../editor/migrateSceneNodes";
import { emptyScene } from "./catalogue";
export interface SceneProject {
  format: "visual-visual";
  version: 2;
  name: string;
  scene: GraphDocument;
  effects: GraphDocument;
  activeTab?: "scene" | "effects";
  viewports?: Partial<
    Record<"scene" | "effects", { x: number; y: number; zoom: number }>
  >;
}
export function parseProject(source: string): SceneProject {
  const value = JSON.parse(source);
  if (value.format === "visual-visual") {
    if (value.version !== 2)
      throw new Error("Unsupported Visual Visual project version.");
    if (typeof value.name !== "string")
      throw new Error("Project needs a name.");
    if (
      value.activeTab !== undefined &&
      !["scene", "effects"].includes(value.activeTab)
    )
      throw new Error("Unknown graph tab.");
    for (const viewport of Object.values(value.viewports ?? {}) as {
      x: number;
      y: number;
      zoom: number;
    }[]) {
      if (
        !viewport ||
        ![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) ||
        viewport.zoom <= 0
      )
        throw new Error("Invalid graph viewport.");
    }
    assertDocument(value.scene);
    assertDocument(value.effects);
    migrateSceneRenderNodes(value.effects);
    const resetControls = (graph: GraphDocument) => {
      for (const node of graph.nodes) {
        if (node.kind === "Button") {
          node.data.pulses = 0;
          if (node.data.mode !== "toggle") node.values.value = 0;
        }
        if (node.graph) resetControls(node.graph);
      }
    };
    resetControls(value.scene);
    return value;
  }
  const patch = parsePatchJson(source);
  return {
    format: "visual-visual",
    version: 2,
    name: patch.name ?? "untitled-patch",
    scene: emptyScene(),
    effects: patchToGraph(patch),
    activeTab: "effects",
  };
}
