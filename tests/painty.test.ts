import assert from "node:assert/strict";
import { test } from "node:test";
import * as T from "three";
import { PaintyMaterial } from "../web/src/scene/PaintyMaterial";
import { parsePainty, readPaintyFile } from "../web/src/scene/painty";
import { createPaintyObject } from "../web/src/scene/paintyObject";
import { parseProject } from "../web/src/scene/project";
import { emptyScene, sceneNodes } from "../web/src/scene/catalogue";

function fixture() {
  return {
    format: "painty", version: 1, width: 1, height: 1,
    settings: {
      fg: "#000000", bg: "#ffffff", palette: [["#ffffff", "#808080", "#000000"]],
      tiles: Array.from({ length: 10 }, () => Array(64).fill(1)), selected: 0, scale: 1, transparent: false,
    },
    document: {
      layersEnabled: false, activeId: "", rotation: { x: 31, y: -44, z: 67 },
      layers: [{ id: "", name: "", visible: true, depth: 3, rotation: { x: 19, y: 23, z: -13 }, pixels: "/wAAgA==" }],
    },
  };
}
test("Painty v1 preserves layers, RGBA alpha, optional defaults and opaque IDs", () => {
  const result = parsePainty(JSON.stringify(fixture()));
  assert.deepEqual(result.layers[0].pixels, new Uint8Array([255, 0, 0, 128]));
  assert.deepEqual(result.position, { x: 0, y: 0, z: 0 });
  assert.deepEqual(result.layers[0].position, { x: 0, y: 0 });
  assert.equal(result.perspective, 0);
  assert.equal(result.layers[0].id, "");
  assert.equal(result.layers[0].depth, 3);
});
test("Painty rejects malformed documents before creating scene resources", async () => {
  const cases: ((value: any) => void)[] = [
    (v) => v.version = 2,
    (v) => v.width = 0,
    (v) => v.width = 1.5,
    (v) => v.height = 4097,
    (v) => v.document.layers = [],
    (v) => v.document.layers.push({ ...v.document.layers[0] }),
    (v) => v.document.layers = Array(65).fill(v.document.layers[0]),
    (v) => { v.width = v.height = 4096; v.document.layers.push({ ...v.document.layers[0], id: "second" }); },
    (v) => v.document.activeId = "missing",
    (v) => v.document.layers[0].name = "x".repeat(81),
    (v) => v.document.layers[0].depth = -4097,
    (v) => v.document.rotation.x = 361,
    (v) => delete v.document.rotation.z,
    (v) => v.document.position = null,
    (v) => v.document.layers[0].position = { x: 0 },
    (v) => v.document.layers[0].visible = 1,
    (v) => v.document.perspective = 1001,
    (v) => v.document.layers[0].pixels = "/wAA/w==\n",
    (v) => v.document.layers[0].pixels = "_wAA_w==",
    (v) => v.document.layers[0].pixels = "AAAAAAAA",
    (v) => v.document.layers[0].pixels = "/wAA/w=",
    (v) => v.document.layers[0].pixels = "data:image/png;base64,/wAA/w==",
    (v) => v.settings.tiles[0][0] = true,
    (v) => v.settings.scale = "1",
    (v) => v.settings.palette[0][0] = "red",
  ];
  for (const mutate of cases) {
    const value = fixture(); mutate(value);
    assert.throws(() => parsePainty(JSON.stringify(value)), /Invalid Painty file/);
  }
  assert.throws(() => parsePainty("{"), /malformed JSON/);
  await assert.rejects(() => readPaintyFile({ size: 146_800_641 } as Blob), /140 MiB/);
});

function rotate(p: T.Vector3, r: { x: number; y: number; z: number }) {
  for (const axis of ["x", "y", "z"] as const) {
    const a = r[axis] * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const { x, y, z } = p;
    if (axis === "x") p.set(x, y * c - z * s, y * s + z * c);
    if (axis === "y") p.set(x * c + z * s, y, -x * s + z * c);
    if (axis === "z") p.set(x * c - y * s, x * s + y * c, z);
  }
  return p;
}
test("Painty hierarchy matches the reference X/Y/Z transform order with Y reflection", () => {
  const doc = parsePainty(JSON.stringify(fixture()));
  doc.position = { x: 5, y: -7, z: 11 };
  doc.layers[0].position = { x: 2, y: -4 };
  doc.layers[0].visible = false;
  const object = createPaintyObject(doc), mesh = object.children[0] as T.Mesh<T.PlaneGeometry, PaintyMaterial>;
  object.updateMatrixWorld(true);
  const source = new T.Vector3(0.5, -0.25, 0);
  const expected = rotate(source.clone(), doc.layers[0].rotation).add(new T.Vector3(2, -4, 3));
  rotate(expected, doc.rotation).add(new T.Vector3(5, -7, 11));
  expected.y *= -1;
  const actual = mesh.localToWorld(new T.Vector3(source.x, -source.y, source.z));
  assert.ok(actual.distanceTo(expected) < 1e-10);
  assert.equal(mesh.visible, false);
  assert.equal(mesh.material.opacity, 1);
  assert.equal(mesh.material.transparent, true);
  assert.equal(mesh.material.map!.flipY, true);
  assert.equal(mesh.material.map!.magFilter, T.NearestFilter);
  assert.equal(mesh.material.map!.colorSpace, T.LinearSRGBColorSpace);
  assert.deepEqual((mesh.material.map!.image as { data: Uint8Array }).data, doc.layers[0].pixels);
  const depth = mesh.children[0] as T.Mesh<T.PlaneGeometry, T.MeshBasicMaterial>;
  assert.equal(depth.material.colorWrite, false);
  assert.equal(depth.material.alphaTest, 1);
  depth.geometry.dispose(); depth.material.dispose();
  mesh.geometry.dispose(); mesh.material.map!.dispose(); mesh.material.dispose();
});
test("Painty nodes retain the asset and modulation controls in saved projects", () => {
  const scene = emptyScene(), painty = sceneNodes.create("Painty", { x: 0, y: 0 }, "drawing");
  painty.data.url = "asset:example/art.bmpy";
  painty.values.opacity = 0.4;
  scene.nodes.push(painty);
  const project = parseProject(JSON.stringify({ format: "visual-visual", version: 2, name: "Painty", scene, effects: emptyScene() }));
  assert.deepEqual(project.scene.nodes[0], painty);
  assert.equal(painty.values.size, 2);
});
