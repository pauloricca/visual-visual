import assert from "node:assert/strict";
import "./painty.test";
import { test } from "node:test";
import {
  GraphEditor,
  type GraphDocument,
  type GraphLink,
} from "@pauloricca/spagbol";
import {
  sceneNodes,
  emptyScene,
  sceneDefinitions,
} from "../web/src/scene/catalogue";
import { SceneEvaluator, evaluateExpression } from "../web/src/scene/evaluate";
import { parseProject } from "../web/src/scene/project";
import { demoPatch } from "../web/src/graph/demoPatch";
import { compilePatchToGlsl } from "../web/src/graph/glsl";
import { graphToPatch, shaderNodes } from "../web/src/editor/patchCodec";
const node = (kind: string, id = kind) =>
  sceneNodes.create(kind, { x: 0, y: 0 }, id);
const link = (
  source: string,
  target: string,
  mode = "set",
  weight = 1,
): GraphLink => ({
  id: `${source}-${mode}`,
  source: { nodeId: source, portId: "value" },
  target: { type: "port", nodeId: target, portId: "positionX" },
  mode,
  weight,
});
test("all scene catalogue definitions have numeric inputs and serializable configuration", () => {
  for (const definition of sceneDefinitions) {
    const n = node(definition.kind);
    assert.deepEqual(JSON.parse(JSON.stringify(n)), n);
    for (const port of definition.ports(n))
      if (port.direction === "input")
        assert.equal(typeof port.defaultValue, "number");
  }
});
test("entity existence is declarative; link modes and modulation use the Spagbol model", () => {
  const sphere = node("Sphere");
  sphere.values.positionX = 999;
  const graph = emptyScene();
  graph.nodes.push(sphere);
  const values = [2, 4, 3, 2, 1];
  graph.nodes.push(
    ...values.map((v, i) => {
      const n = node("Constant", String(i));
      n.values.value = v;
      return n;
    }),
  );
  graph.links = [
    link("0", "Sphere"),
    link("1", "Sphere"),
    link("2", "Sphere", "add"),
    link("3", "Sphere", "multiply"),
    link("4", "Sphere", "bend"),
  ];
  const engine = new SceneEvaluator();
  assert.equal(engine.evaluate(graph, 0)[0].values.positionX, 24);
  const mod = node("Constant", "mod");
  mod.values.value = 0.5;
  graph.nodes.push(mod);
  graph.links.push({
    ...link("mod", "Sphere"),
    id: "mod",
    target: { type: "link", linkId: "3-multiply", property: "weight" },
  });
  assert.equal(engine.evaluate(graph, 1)[0].values.positionX, 12);
  graph.nodes = [];
  graph.links = [];
  assert.equal(engine.evaluate(graph, 2).length, 0);
});
test("Spread maintains stable IDs when count changes and exposes instance index", () => {
  const spread = node("Spread");
  spread.values.count = 3;
  const sphere = node("Sphere"),
    index = node("Instance");
  spread.graph!.nodes.push(sphere, index);
  spread.graph!.links.push({
    ...link("Instance", "Sphere"),
    source: { nodeId: "Instance", portId: "index" },
  });
  const graph = emptyScene();
  graph.nodes.push(spread);
  const engine = new SceneEvaluator();
  const first = engine.evaluate(graph, 0);
  assert.deepEqual(
    first.map((e) => e.values.positionX),
    [1, 2, 3],
  );
  spread.values.count = 2;
  assert.deepEqual(
    engine.evaluate(graph, 1).map((e) => e.id),
    first.slice(0, 2).map((e) => e.id),
  );
});
test("Spawn responds to rising triggers, expires independently and cleans state", () => {
  const spawn = node("Spawn");
  spawn.graph!.nodes.push(node("Sphere"));
  spawn.values.lifetime = 2;
  const graph = emptyScene();
  graph.nodes.push(spawn);
  const engine = new SceneEvaluator();
  assert.equal(engine.evaluate(graph, 0).length, 0);
  spawn.values.trigger = 1;
  const first = engine.evaluate(graph, 0.1);
  assert.equal(first.length, 1);
  assert.equal(engine.evaluate(graph, 0.2).length, 1);
  spawn.values.trigger = 0;
  engine.evaluate(graph, 0.3);
  spawn.values.trigger = 1;
  assert.equal(engine.evaluate(graph, 0.4).length, 2);
  for (let i = 5; i <= 24; i++) engine.evaluate(graph, i / 10);
  assert.equal(engine.evaluate(graph, 2.5).length, 0);
  graph.nodes = [];
  engine.evaluate(graph, 4);
  assert.equal(engine.states.size, 0);
});
test("conditional scope freezes and hides existing entities; reactivation keeps identity", () => {
  const condition = node("Conditional Execution");
  condition.values.gate = 1;
  const sphere = node("Sphere");
  condition.graph!.nodes.push(sphere);
  const graph = emptyScene();
  graph.nodes.push(condition);
  const engine = new SceneEvaluator();
  const first = engine.evaluate(graph, 0)[0];
  condition.values.gate = 0;
  sphere.values.positionX = 4;
  const hidden = engine.evaluate(graph, 1)[0];
  assert.equal(hidden.visible, false);
  assert.equal(hidden.values.positionX, 0);
  condition.values.gate = 1;
  const resumed = engine.evaluate(graph, 2)[0];
  assert.equal(resumed.id, first.id);
  assert.equal(resumed.values.positionX, 4);
});
test("Curve and Sequence are driven by position; expression parsing is numeric only", () => {
  const curve = node("Curve"),
    sequence = node("Sequence"),
    sphere = node("Sphere");
  curve.values.position = 0.5;
  curve.data.points = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ];
  sequence.values.position = 2 / 16;
  sequence.data.items = [{ id: 1, start: 1, end: 3, level: 0.75 }];
  const graph = emptyScene();
  graph.nodes.push(curve, sequence, sphere);
  graph.links.push(link("Curve", "Sphere"), {
    ...link("Sequence", "Sphere"),
    target: { type: "port", nodeId: "Sphere", portId: "positionY" },
  });
  const result = new SceneEvaluator().evaluate(graph, 0)[0];
  assert.equal(result.values.positionX, 0.5);
  assert.equal(result.values.positionY, 0.75);
  assert.equal(
    evaluateExpression("sin(a) + pow(b, 2)", (n) => (n === "a" ? 0 : 3)),
    9,
  );
  assert.equal(
    evaluateExpression("globalThis.alert(1)", () => 0),
    0,
  );
});
test("projects roundtrip both graphs and viewports; legacy shader patches still load", () => {
  const scene = emptyScene();
  scene.nodes.push(node("Sphere"));
  scene.data = { activeCamera: "camera" };
  const original = {
    format: "visual-visual",
    version: 2,
    name: "test",
    scene,
    effects: emptyScene(),
    activeTab: "scene",
    viewports: { scene: { x: 3, y: 4, zoom: 2 } },
  };
  assert.deepEqual(parseProject(JSON.stringify(original)), original);
  const legacy = parseProject(JSON.stringify(demoPatch));
  assert.equal(legacy.scene.nodes.length, 0);
  assert.equal(legacy.effects.nodes.length, demoPatch.nodes.length);
  assert.throws(() => parseProject('{"format":"visual-visual","version":99}'));
});
test("Scene samples explicit XY coordinates and exposes only RGB floats", () => {
  const source = shaderNodes.create("Scene", { x: 0, y: 0 }, "scene");
  assert.deepEqual(source.values, { x: 0, y: 0 });
  assert.deepEqual(shaderNodes.get("Scene")!.ports(source).map((p) => p.id), ["x", "y", "r", "g", "b"]);
  assert.equal(shaderNodes.get("Scene Render"), undefined);
  const result = compilePatchToGlsl(
    {
      nodes: [
        { id: "coords", type: "System", params: {} },
        { id: "scene", type: "Scene", params: {} },
        { id: "output", type: "Output", params: {} },
      ],
      links: [
        ...["x", "y"].map((port) => ({ from: { node: "coords", port }, to: { node: "scene", port } })),
        ...["r", "g", "b"].map((port) => ({ from: { node: "scene", port }, to: { node: "output", port } })),
      ],
    },
    "webgl2",
  );
  assert.equal(result.ok, true);
  assert.match(result.shaderCode, /uniform sampler2D u_scene/);
  assert.match(result.shaderCode, /texture\(u_scene, clamp\(vec2\(/);
  assert.doesNotMatch(result.shaderCode, /uv \+ vec2/);
  assert.deepEqual(result.media, { useMic: false, useCamera: false });
});
test("saved Scene Render nodes migrate to explicit coordinates without losing offset link arithmetic", () => {
  const effects = emptyScene();
  effects.nodes.push(
    { id: "scene", kind: "Scene Render", position: { x: 500, y: 0 }, values: { offsetX: 0.2, offsetY: 0 }, data: {} },
    shaderNodes.create("Constant", { x: 0, y: 0 }, "control"),
    shaderNodes.create("Output", { x: 900, y: 0 }, "out"),
  );
  effects.links.push(
    { id: "offset", source: { nodeId: "control", portId: "value" }, target: { type: "port", nodeId: "scene", portId: "offsetX" }, mode: "multiply", weight: 0.3 },
    { id: "colour", source: { nodeId: "scene", portId: "r" }, target: { type: "port", nodeId: "out", portId: "r" }, mode: "set", weight: 1 },
  );
  const project = parseProject(JSON.stringify({ format: "visual-visual", version: 2, name: "old", scene: emptyScene(), effects }));
  const migrated = project.effects;
  assert.equal(migrated.nodes[0].kind, "Scene");
  assert.deepEqual(migrated.nodes[0].values, { x: 0, y: 0 });
  const add = migrated.nodes.find((n) => n.kind === "Add")!;
  const system = migrated.nodes.find((n) => n.kind === "System")!;
  assert.equal(add.values.b, 0.2);
  assert.deepEqual(migrated.links[0], { ...effects.links[0], target: { type: "port", nodeId: add.id, portId: "b" } });
  assert(migrated.links.some((l) => l.source.nodeId === system.id && l.source.portId === "y" && l.target.type === "port" && l.target.nodeId === "scene" && l.target.portId === "y"));
  assert.equal(compilePatchToGlsl(graphToPatch(migrated), "webgl2").ok, true);
  assert.deepEqual(parseProject(JSON.stringify(project)), project);
});
test("scene scope editing uses Spagbol history", () => {
  const graph = emptyScene();
  graph.nodes.push(node("Spread"));
  const editor = new GraphEditor({ nodes: sceneNodes, document: graph });
  editor.enter("Spread");
  editor.edit("Add sphere", "structure", (g) => g.nodes.push(node("Sphere")));
  assert.equal(editor.getSnapshot().document.nodes[0].graph!.nodes.length, 1);
  editor.undo();
  assert.equal(editor.getSnapshot().document.nodes[0].graph!.nodes.length, 0);
});
test("Selector latches one-based input selections and slides in seconds", () => {
  const selector = node("Selector"),
    sphere = node("Sphere");
  selector.values.a = 10;
  selector.values.b = 20;
  const graph = emptyScene();
  graph.nodes.push(selector, sphere);
  graph.links.push(link("Selector", "Sphere"));
  const engine = new SceneEvaluator(),
    results: number[] = [];
  [0, 2.9, 0, 99, 1].forEach((value, i) => {
    selector.values.select = value;
    results.push(engine.evaluate(graph, i * 0.1)[0].values.positionX);
  });
  assert.deepEqual(results, [0, 20, 20, 20, 10]);
  selector.values.slide = 1;
  selector.values.select = 2;
  assert.equal(engine.evaluate(graph, 0.5)[0].values.positionX, 10);
  for (let i = 6; i <= 10; i++) engine.evaluate(graph, i / 10);
  assert.ok(
    Math.abs(engine.evaluate(graph, 1)[0].values.positionX - 15) < 1e-6,
  );
});
test("Accumulator respects reset priority, trigger edges and endpoint wrap", () => {
  const accumulator = node("Accumulator"),
    sphere = node("Sphere");
  accumulator.values.max = 2;
  const graph = emptyScene();
  graph.nodes.push(accumulator, sphere);
  graph.links.push(link("Accumulator", "Sphere"));
  const engine = new SceneEvaluator();
  const values = [0, 1, 1, 0, 1, 0, 1].map((trigger, i) => {
    accumulator.values.trigger = trigger;
    return engine.evaluate(graph, i / 60)[0].values.positionX;
  });
  assert.deepEqual(values, [0, 1, 1, 1, 2, 2, 0]);
  accumulator.values.reset = 1;
  accumulator.values.trigger = 1;
  assert.equal(engine.evaluate(graph, 1)[0].values.positionX, 0);
});
test("Spawn release gates retain instances; local kill disposes after its final tick", () => {
  const spawn = node("Spawn"),
    instance = node("Instance"),
    sphere = node("Sphere");
  spawn.values.trigger = 7;
  spawn.values.release = 7;
  spawn.graph!.nodes.push(instance, sphere);
  spawn.graph!.links.push({
    ...link("Instance", "Sphere"),
    source: { nodeId: "Instance", portId: "gate" },
  });
  const graph = emptyScene();
  graph.nodes.push(spawn);
  const engine = new SceneEvaluator();
  assert.equal(engine.evaluate(graph, 0)[0].values.positionX, 0);
  spawn.values.trigger = 0;
  spawn.values.release = 0;
  assert.equal(engine.evaluate(graph, 0.1).length, 1);
  instance.values.kill = 1;
  assert.equal(engine.evaluate(graph, 0.2).length, 1);
  assert.equal(engine.evaluate(graph, 0.3).length, 0);
});
test("Spagbol groups preserve float boundary wiring and declarative child entities", () => {
  const group = node("spagbol.group", "group");
  const ins = group.graph!.nodes[0],
    outs = group.graph!.nodes[1],
    sphere = node("Sphere"),
    constant = node("Constant");
  ins.ports = [{ id: "in", label: "in", direction: "output", defaultValue: 0 }];
  outs.ports = [
    { id: "out", label: "out", direction: "input", defaultValue: 0 },
  ];
  group.ports = [
    { ...ins.ports[0], direction: "input" },
    { ...outs.ports[0], direction: "output" },
  ];
  group.values.in = 4;
  group.graph!.nodes.push(sphere, constant);
  constant.values.value = 7;
  group.graph!.links.push(
    { ...link(ins.id, sphere.id), source: { nodeId: ins.id, portId: "in" } },
    {
      ...link(constant.id, outs.id),
      target: { type: "port", nodeId: outs.id, portId: "out" },
    },
  );
  const outer = node("Sphere", "outer");
  const graph = emptyScene();
  graph.nodes.push(group, outer);
  graph.links.push({
    ...link(group.id, outer.id),
    source: { nodeId: group.id, portId: "out" },
  });
  const entities = new SceneEvaluator().evaluate(graph, 0);
  assert.deepEqual(
    entities.map((e) => e.values.positionX),
    [4, 7],
  );
});

test('execution areas migrate contents and preserve instancing with editable membership', async () => {
  const { normalizeExecutionAreas, executionGraph } = await import('../web/src/scene/executionAreas');
  const graph = emptyScene();
  const spread = node('Spread', 'area-spread');
  spread.values.count = 3;
  const sphere = node('Sphere', 'area-sphere');
  spread.graph!.nodes.push(sphere);
  graph.nodes.push(spread);
  const before = new SceneEvaluator().evaluate(graph, 0);
  normalizeExecutionAreas(graph);
  assert.equal(graph.areas.length, 1);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[0].graph, undefined);
  assert.equal(executionGraph(graph).nodes.length, 1);
  assert.equal(new SceneEvaluator().evaluate(graph, 0).length, before.length);
  normalizeExecutionAreas(graph);
  assert.equal(graph.areas.length, 1);
  const member = graph.nodes.find(n => n.kind === 'Sphere')!;
  member.position = { x: 2000, y: 2000 };
  assert.equal(new SceneEvaluator().evaluate(graph, 0).length, 1);
});

test('Effects disabled nodes compile to zero and disabled links stop contributing', () => {
  const graph = emptyScene();
  const value = shaderNodes.create('Constant', {x:0,y:0}, 'disabled-value');
  value.values.value = 0.75;
  const output = shaderNodes.create('Output', {x:300,y:0}, 'disable-output');
  graph.nodes.push(value, output);
  graph.links.push({id:'disable-link', source:{nodeId:value.id,portId:'value'},target:{type:'port',nodeId:output.id,portId:'r'},mode:'set',weight:1});
  value.enabled = false;
  const patch = graphToPatch(graph);
  assert.equal(patch.nodes[0].enabled, false);
  const compiled = compilePatchToGlsl(patch);
  assert.equal(compiled.ok, true);
  assert.match(compiled.shaderCode, /= 0\.0;/);
  graph.links[0].enabled = false;
  assert.equal(graphToPatch(graph).links.length, 0);
  assert.equal(graph.links.length, 1);
  output.enabled = false;
  assert.equal(compilePatchToGlsl(graphToPatch(graph)).ok, true);
});

test('nested execution areas preserve Spawn lifecycle and Conditional Execution gating', async () => {
  const { normalizeExecutionAreas } = await import('../web/src/scene/executionAreas');
  const graph = emptyScene();
  const conditional = node('Conditional Execution', 'area-condition');
  conditional.values.gate = 1;
  const spawn = node('Spawn', 'area-spawn');
  spawn.values.trigger = 1;
  spawn.graph!.nodes.push(node('Sphere', 'spawn-sphere'));
  conditional.graph!.nodes.push(spawn);
  graph.nodes.push(conditional);
  normalizeExecutionAreas(graph);
  assert.equal(graph.areas.length, 2);
  const evaluator = new SceneEvaluator();
  const entities = evaluator.evaluate(graph, 0);
  assert.equal(entities.length, 1);
  assert.equal(entities[0].visible, true);
  conditional.values.gate = 0;
  assert.equal(evaluator.evaluate(graph, 0.1)[0].visible, false);
  conditional.values.gate = 1;
  assert.equal(evaluator.evaluate(graph, 0.2)[0].id, entities[0].id);
  const editor = new GraphEditor({nodes: sceneNodes, document: graph, normalizeDocument: normalizeExecutionAreas});
  const owner = graph.areas.find(a => a.ownerNodeId === conditional.id)!;
  editor.select({areaIds: [owner.id]});
  editor.deleteSelection();
  assert.equal(editor.graph.nodes.length, 0);
  editor.undo();
  assert.equal(new SceneEvaluator().evaluate(editor.graph, 0).length, 1);
});
