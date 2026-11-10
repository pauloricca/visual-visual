import assert from "node:assert/strict";
import { chromium } from "playwright";

const zero = { x: 0, y: 0, z: 0 };
const layer = (id, pixels, depth = 0) => ({
  id, name: id, visible: true, depth, rotation: zero,
  pixels: Buffer.from(pixels).toString("base64"),
});
const fixture = {
  format: "painty", version: 1, width: 2, height: 2,
  settings: {
    fg: "#000000", bg: "#ffffff", palette: [["#ffffff", "#808080", "#000000"]],
    tiles: Array.from({ length: 10 }, () => Array(64).fill(1)), selected: 0, scale: 1, transparent: false,
  },
  document: {
    layersEnabled: true, activeId: "front", rotation: zero,
    layers: [
      // Closer plane is FIRST in the stack: depth takes precedence over array order.
      layer("front", [0, 255, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0.2),
      layer("back", [255, 0, 0, 255, 128, 64, 32, 255, 0, 0, 255, 255, 0, 0, 255, 255]),
      { ...layer("hidden", Array(4).fill([255, 255, 255, 255]).flat(), 1), visible: false },
    ],
  },
};
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text());
  });
  await page.goto(process.env.SCENE_TEST_URL ?? "http://127.0.0.1:5199");
  const project = await page.evaluate(async () => {
    const { sceneNodes, emptyScene } = await import("/src/scene/catalogue.ts");
    const scene = emptyScene();
    const painty = sceneNodes.create("Painty", { x: 20, y: 50 }, "drawing");
    scene.nodes.push(painty);
    const camera = sceneNodes.create("Orthographic Camera", { x: 500, y: 50 }, "camera");
    camera.values.size = 4;
    scene.nodes.push(camera);
    return { format: "visual-visual", version: 2, name: "painty-test", scene, effects: emptyScene(), activeTab: "scene", viewports: { scene: { x: 0, y: 0, zoom: 0.5 } } };
  });
  await page.addInitScript((project) => {
    if (!sessionStorage.getItem("painty-test-seeded")) {
      localStorage.setItem("visual-visual.project.v2", JSON.stringify(project));
      sessionStorage.setItem("painty-test-seeded", "true");
    }
  }, project);
  await page.reload();
  await page.getByLabel("Painty file", { exact: true }).setInputFiles({ name: "layers.BMPY", mimeType: "application/x-bmpy", buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("visual-visual.project.v2")).scene.nodes.find((n) => n.kind === "Painty").data.url?.startsWith("asset:"));
  const reference = await page.evaluate(() => JSON.parse(localStorage.getItem("visual-visual.project.v2")).scene.nodes.find((n) => n.kind === "Painty").data.url);
  const frontCheckbox = page.getByRole("checkbox", { name: "Painty layer front", exact: true });
  const hiddenCheckbox = page.getByRole("checkbox", { name: "Painty layer hidden", exact: true });
  await frontCheckbox.waitFor();
  assert(await frontCheckbox.isChecked());
  assert(!(await hiddenCheckbox.isChecked()));
  await frontCheckbox.uncheck();
  await hiddenCheckbox.check();
  await page.waitForFunction(() => {
    const visibility = JSON.parse(localStorage.getItem("visual-visual.project.v2")).scene.nodes.find((n) => n.kind === "Painty").data.paintyLayerVisibility;
    return visibility?.front === false && visibility?.hidden === true;
  });
  await page.reload();
  await frontCheckbox.waitFor();
  assert(!(await frontCheckbox.isChecked()), "unchecked layer persists on reload");
  assert(await hiddenCheckbox.isChecked(), "a layer hidden in Painty can be shown and saved");
  // A new file resets overrides, even when its layer IDs match the old drawing.
  await page.getByLabel("Painty file", { exact: true }).setInputFiles({ name: "replacement.bmpy", mimeType: "application/x-bmpy", buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.waitForFunction((old) => JSON.parse(localStorage.getItem("visual-visual.project.v2")).scene.nodes.find((n) => n.kind === "Painty").data.url !== old, reference);
  await page.waitForFunction(() => document.querySelector('input[aria-label="Painty layer front"]')?.checked === true && document.querySelector('input[aria-label="Painty layer hidden"]')?.checked === false);
  const replacementReference = await page.evaluate(() => JSON.parse(localStorage.getItem("visual-visual.project.v2")).scene.nodes.find((n) => n.kind === "Painty").data.url);
  // Invalid replacements leave the existing file reference intact.
  await page.getByLabel("Painty file", { exact: true }).setInputFiles({ name: "bad.bmpy", mimeType: "application/x-bmpy", buffer: Buffer.from('{"format":"painty","version":99}') });
  await page.getByRole("alert").filter({ hasText: "unsupported version" }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("visual-visual.project.v2")).scene.nodes.find((n) => n.kind === "Painty").data.url), replacementReference);
  // Reload also checks that IndexedDB retains the original file.
  await page.reload();
  const result = await page.evaluate(async (fixture) => {
    const resource = performance.getEntriesByType("resource").find((e) => e.name.includes("/src/scene/SceneRenderer.ts"));
    const { SceneRenderer } = await import(resource.name);
    const { sceneNodes, emptyScene } = await import("/src/scene/catalogue.ts");
    const project = JSON.parse(localStorage.getItem("visual-visual.project.v2"));
    const canvas = document.createElement("canvas");
    const runtime = new SceneRenderer(canvas.getContext("webgl2"), canvas);
    const graph = project.scene;
    runtime.render(graph, 64, 64, 0);
    for (let i = 0; i < 100 && !runtime.entities.get("drawing").painty; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (runtime.entities.get("drawing").error) throw new Error(runtime.entities.get("drawing").error);
    }
    runtime.render(graph, 64, 64, 1);
    const entity = runtime.entities.get("drawing");
    if (!entity.painty) throw new Error("Painty did not load");
    const pixel = (x, y) => {
      const p = new Uint8Array(4);
      runtime.renderer.readRenderTargetPixels(runtime.target, x, y, 1, 1, p);
      return [...p];
    };
    const topLeft = pixel(24, 40), topRight = pixel(40, 40), bottom = pixel(24, 24);
    const paintyDocument = entity.painty.container.children[0];
    const layers = paintyDocument.children;
    const hidden = !layers[2].visible;
    const node = graph.nodes.find((n) => n.id === "drawing");
    const originalData = node.data;
    node.data = { ...originalData, paintyLayerVisibility: { front: false, hidden: true } };
    runtime.render(graph, 64, 64, 1.1);
    const toggled = pixel(24, 40);
    const visibilityStable = runtime.entities.get("drawing") === entity && layers[0].material.map === entity.painty.container.children[0].children[0].material.map && !layers[0].visible && layers[2].visible;
    node.data = originalData;
    runtime.render(graph, 64, 64, 1.2);
    const restored = layers[0].visible && !layers[2].visible;
    node.values.opacity = 0.5;
    node.values.size = 3;
    node.values.rotationX = 0.2;
    runtime.render(graph, 64, 64, 2);
    const stable = runtime.entities.get("drawing") === entity && layers[0].material.opacity === 0.5 && entity.painty.container.scale.x === 1.5 && entity.object.rotation.x === 0.2;
    const textures = layers.map((m) => m.material.map);
    let disposed = 0;
    textures.forEach((t) => t.addEventListener("dispose", () => disposed++));
    graph.nodes = [];
    runtime.render(graph, 64, 64, 3);
    const removed = entity.disposed && runtime.entities.size === 0 && disposed === 3;
    // Oppositely rotated opaque planes intersect: each must cover half the other.
    const crossing = structuredClone(fixture);
    crossing.document.activeId = "red";
    crossing.document.layers = [
      { ...crossing.document.layers[0], id: "red", depth: 0, rotation: { x: 0, y: 45, z: 0 }, pixels: btoa(String.fromCharCode(...Array(4).fill([255, 0, 0, 255]).flat())) },
      { ...crossing.document.layers[1], id: "blue", depth: 0, rotation: { x: 0, y: -45, z: 0 }, pixels: btoa(String.fromCharCode(...Array(4).fill([0, 0, 255, 255]).flat())) },
    ];
    const crossingGraph = JSON.parse(localStorage.getItem("visual-visual.project.v2")).scene;
    crossingGraph.nodes.find((n) => n.id === "drawing").data.url = `data:application/x-bmpy,${encodeURIComponent(JSON.stringify(crossing))}`;
    runtime.render(crossingGraph, 64, 64, 4);
    for (let i = 0; i < 100 && !runtime.entities.get("drawing").painty; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    runtime.render(crossingGraph, 64, 64, 5);
    const crossingLeft = pixel(24, 32), crossingRight = pixel(40, 32);
    const crossingLayers = runtime.entities.get("drawing").painty.container.children[0].children;
    crossingLayers.forEach((layer) => layer.rotation.set(0, 0, 0));
    runtime.render(crossingGraph, 64, 64, 6);
    const tied = pixel(32, 32);
    // A box in front of the artwork casts an offset shadow onto its white pixels.
    const shadowDocument = structuredClone(fixture);
    shadowDocument.document.activeId = "receiver";
    shadowDocument.document.layers = [{
      ...shadowDocument.document.layers[0], id: "receiver", depth: 0,
      pixels: btoa(String.fromCharCode(...Array(4).fill([255, 255, 255, 255]).flat())),
    }];
    const shadowGraph = emptyScene();
    const receiver = sceneNodes.create("Painty", { x: 0, y: 0 }, "receiver");
    receiver.values.size = 4;
    receiver.data.shadows = true;
    receiver.data.url = `data:application/x-bmpy,${encodeURIComponent(JSON.stringify(shadowDocument))}`;
    const box = sceneNodes.create("Box", { x: 0, y: 0 }, "caster");
    box.values.width = box.values.height = box.values.depth = 0.5;
    box.values.positionZ = 1;
    box.data.shadows = true;
    const camera = sceneNodes.create("Orthographic Camera", { x: 0, y: 0 }, "camera");
    camera.values.size = 4;
    shadowGraph.nodes.push(receiver, box, camera);
    const renderShadows = async (time) => {
      runtime.render(shadowGraph, 128, 128, time);
      for (let i = 0; i < 100 && !runtime.entities.get("receiver").painty; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      runtime.render(shadowGraph, 128, 128, time);
    };
    await renderShadows(7);
    const unshadowed = pixel(46, 64);
    const shadowSamples = [];
    for (const kind of ["Directional Light", "Point Light", "Spot Light"]) {
      const light = sceneNodes.create(kind, { x: 0, y: 0 }, "shadow-light");
      light.data.shadows = true;
      light.data.shadowResolution = 512;
      light.values.rotationX = light.values.rotationZ = 0;
      light.values.rotationY = Math.atan(0.5);
      light.values.positionX = 3;
      light.values.positionY = 0;
      light.values.positionZ = 6;
      light.values.shadowSize = 6;
      shadowGraph.nodes = [receiver, box, camera, light];
      await renderShadows(8);
      shadowSamples.push({ kind, shadow: pixel(46, 64), clear: pixel(90, 90) });
    }
    receiver.data = { ...receiver.data, shadows: false };
    await renderShadows(9);
    const disabled = pixel(46, 64);
    runtime.dispose();
    return { topLeft, topRight, bottom, hidden, stable, removed, crossingLeft, crossingRight, tied, toggled, visibilityStable, restored, unshadowed, shadowSamples, disabled };
  }, fixture);
  assert(result.topLeft[0] > 120 && result.topLeft[0] < 135 && result.topLeft[1] > 120 && result.topLeft[1] < 135 && result.topLeft[2] < 5, `depth and alpha: ${result.topLeft}`);
  assert.deepEqual(result.topRight, [128, 64, 32, 255], "top-row midtone colors are preserved without gamma conversion");
  assert(result.bottom[0] < 5 && result.bottom[1] < 5 && result.bottom[2] > 250, `bottom row: ${result.bottom}`);
  assert(result.hidden && result.stable && result.removed);
  assert(result.visibilityStable && result.restored, "visibility toggles reuse existing GPU resources and restore source defaults");
  assert.deepEqual(result.toggled, [255, 255, 255, 255], "showing the hidden layer updates GPU output");
  assert.deepEqual(result.crossingLeft, [255, 0, 0, 255], "red intersecting plane occludes on the left");
  assert.deepEqual(result.crossingRight, [0, 0, 255, 255], "blue intersecting plane occludes on the right");
  assert.deepEqual(result.tied, [0, 0, 255, 255], "equal-depth layers retain bottom-to-top stack order");
  assert.deepEqual(result.unshadowed, [255, 255, 255, 255]);
  for (const { kind, shadow, clear } of result.shadowSamples) {
    assert(shadow[0] < 80 && shadow[1] < 80 && shadow[2] < 80, `${kind} casts onto Painty pixels: ${shadow}`);
    assert.deepEqual(clear, [255, 255, 255, 255], `${kind} preserves unshadowed painted colors`);
  }
  assert.deepEqual(result.disabled, [255, 255, 255, 255], "Painty's Shadows checkbox disables shadow receiving");
  assert.deepEqual(errors, []);
  console.log("Painty layer visibility, RGBA, depth, Directional/Point/Spot shadows, shadow toggle and disposal passed.");
} finally {
  await browser.close();
}
