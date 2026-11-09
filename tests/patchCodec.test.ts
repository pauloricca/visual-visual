import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GraphEditor,
  spagbolGroupKinds,
  type GraphDocument,
} from "@pauloricca/spagbol";
import {
  patchToGraph,
  graphToPatch,
  shaderNodes,
  readEditorState,
} from "../web/src/editor/patchCodec";
import { parsePatchJson } from "../web/src/graph/parse";
import { compilePatchToGlsl } from "../web/src/graph/glsl";
import { validatePatch } from "../web/src/graph/validate";
import { demoPatch } from "../web/src/graph/demoPatch";
import { applyMidiValues } from "../web/src/editor/useMidi";
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : e.name.endsWith(".json")
        ? [join(dir, e.name)]
        : [],
  );
}
for (const path of [
  ...files("tests/fixtures"),
  ...(existsSync("patches") ? files("patches") : []),
])
  test(`shader and validation parity: ${path}`, () => {
    const patch = parsePatchJson(readFileSync(path, "utf8"));
    const converted = graphToPatch(patchToGraph(patch));
    assert.deepEqual(validatePatch(converted), validatePatch(patch));
    const before = compilePatchToGlsl(patch, "webgl2");
    const after = compilePatchToGlsl(converted, "webgl2");
    assert.deepEqual(after, before);
  });
test("every node kind creates a serializable graph and valid ports", () => {
  for (const definition of shaderNodes.list()) {
    const node = shaderNodes.create(definition.kind, { x: 0, y: 0 });
    const graph: GraphDocument = {
      format: "spagbol",
      version: 1,
      nodes: [node],
      links: [],
      areas: [],
    };
    const patch = graphToPatch(graph);
    assert.equal(
      parsePatchJson(JSON.stringify(patch)).nodes[0].type,
      patch.nodes[0].type,
    );
  }
});
test("grouping, nested edits and undo preserve shader execution", () => {
  const editor = new GraphEditor({
    nodes: shaderNodes,
    document: patchToGraph(demoPatch),
    policy: { linkProperties: [], modes: ["set", "add", "multiply"] },
  });
  editor.select({ nodeIds: ["multiply_1", "sin_1"] });
  const id = editor.groupSelection()!;
  const grouped = graphToPatch(editor.getSnapshot().document);
  assert.equal(validatePatch(grouped).ok, true);
  assert.equal(compilePatchToGlsl(grouped, "webgl2").ok, true);
  editor.enter(id);
  editor.setValue("multiply_1", "b", 25);
  editor.exit();
  const group = graphToPatch(editor.getSnapshot().document).nodes.find(
    (n) => n.type === "Group",
  )!;
  assert.equal(
    group.subpatch!.nodes.find((n) => n.id === "multiply_1")!.params.b,
    25,
  );
  editor.undo();
  assert.equal(
    graphToPatch(editor.getSnapshot().document)
      .nodes.find((n) => n.type === "Group")!
      .subpatch!.nodes.find((n) => n.id === "multiply_1")!.params.b,
    80,
  );
  editor.undo();
  assert.deepEqual(
    compilePatchToGlsl(graphToPatch(editor.getSnapshot().document), "webgl2"),
    compilePatchToGlsl(demoPatch, "webgl2"),
  );
});
test("expression topology edits remove invalid links and undo restores them", () => {
  const graph = patchToGraph({
    nodes: [
      {
        id: "e",
        type: "Expression",
        expression: "a+b",
        inputs: [{ name: "a" }, { name: "b" }],
        params: { a: 1, b: 2 },
      },
      demoPatch.nodes[0],
    ],
    links: [
      { from: { node: "system_1", port: "x" }, to: { node: "e", port: "b" } },
    ],
  });
  const editor = new GraphEditor({ nodes: shaderNodes, document: graph });
  editor.updateNode("e", { data: { expression: "a" } }, "structure");
  assert.equal(editor.graph.links.length, 0);
  editor.undo();
  assert.equal(editor.graph.links.length, 1);
});
test("MIDI observations preserve graph and undo history", () => {
  const editor = new GraphEditor({
    nodes: shaderNodes,
    document: patchToGraph({
      nodes: [
        { id: "cc", type: "midiCC", params: { channel: 1, cc: 7, value: 0 } },
      ],
      links: [],
    }),
  });
  editor.setValue("cc", "cc", 9);
  const observed = applyMidiValues(graphToPatch(editor.graph), { "1:9": 0.8 });
  assert.equal(observed.nodes[0].params.value, 0.8);
  assert.equal(editor.graph.nodes[0].values.value, 0);
  assert.equal(editor.getSnapshot().canUndo, true);
});
test("legacy browser state imports without overwriting the original", () => {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v);
    },
  } as Storage;
  const state = {
    version: 1,
    nodes: [
      ...demoPatch.nodes,
      { id: "draft", type: null, params: {}, position: { x: 0, y: 0 } },
    ],
    edges: demoPatch.links.map((link, i) => ({
      id: String(i),
      source: link.from.node,
      sourceHandle: `out:${link.from.port}`,
      target: link.to.node,
      targetHandle: `in:${link.to.port}`,
    })),
    ui: { patchName: "legacy", viewport: { x: 12, y: 20, zoom: 0.7 } },
  };
  store.set("visual-visual.editor-state.v1", JSON.stringify(state));
  const loaded = readEditorState()!;
  assert.equal(loaded.document.nodes.length, 7);
  assert.equal(loaded.document.links.length, 8);
  assert.equal(loaded.ui!.patchName, "legacy");
  assert.equal(store.size, 1);
});

test("legacy reversed handles and connected placeholders retain endpoints and downstream modes", () => {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
  } as Storage;
  store.set(
    "visual-visual.editor-state.v1",
    JSON.stringify({
      version: 1,
      nodes: [
        demoPatch.nodes[0],
        demoPatch.nodes.at(-1),
        { id: "draft", type: null, params: {}, position: { x: 0, y: 0 } },
      ],
      edges: [
        {
          source: "draft",
          sourceHandle: "in:value",
          target: "system_1",
          targetHandle: "out:x",
        },
        {
          source: "draft",
          sourceHandle: "out:value",
          target: "output_1",
          targetHandle: "in:r",
          weight: 0.25,
          mode: "add",
        },
      ],
    }),
  );
  const patch = graphToPatch(readEditorState()!.document);
  assert.equal(patch.nodes.length, 2);
  assert.deepEqual(patch.links, [
    {
      from: { node: "system_1", port: "x" },
      to: { node: "output_1", port: "r" },
      weight: 0.25,
      mode: "add",
    },
  ]);
  store.set("visual-visual.editor-state.v2", '{"document":{}}');
  assert.equal(readEditorState()!.document.nodes.length, 2);
});
