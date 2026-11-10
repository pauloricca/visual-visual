import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 850 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("404"))
      errors.push(message.text());
  });
  await page.goto(process.env.SCENE_TEST_URL ?? "http://127.0.0.1:5199");
  const fixture = await page.evaluate(async () => {
    const { sceneNodes, emptyScene } = await import("/src/scene/catalogue.ts");
    const { shaderNodes } = await import("/src/editor/patchCodec.ts");
    const scene = emptyScene(),
      effects = emptyScene();
    const sphere = sceneNodes.create("Sphere", { x: 30, y: 80 }, "sphere");
    sphere.data.material = "basic";
    sphere.values.colourG = sphere.values.colourB = 0;
    scene.nodes.push(sphere);
    const source = shaderNodes.create(
      "Scene",
      { x: 30, y: 80 },
      "source",
    );
    const out = shaderNodes.create("Output", { x: 340, y: 80 }, "out");
    const coords = shaderNodes.create("System", { x: -240, y: 80 }, "coords");
    effects.nodes.push(source, out, coords);
    for (const portId of ["x", "y"]) effects.links.push({
      id: `coord-${portId}`, source: { nodeId: coords.id, portId },
      target: { type: "port", nodeId: source.id, portId }, mode: "set", weight: 1,
    });
    effects.links.push({
      id: "r-to-g",
      source: { nodeId: "source", portId: "r" },
      target: { type: "port", nodeId: "out", portId: "g" },
      mode: "set",
      weight: 1,
    });
    return JSON.stringify({
      format: "visual-visual",
      version: 2,
      name: "browser-test",
      scene,
      effects,
      activeTab: "scene",
      viewports: {
        scene: { x: 0, y: 0, zoom: 0.55 },
        effects: { x: 10, y: 20, zoom: 1 },
      },
    });
  });
  await page.addInitScript(
    (fixture) => localStorage.setItem("visual-visual.project.v2", fixture),
    fixture,
  );
  await page.reload();
  await page.getByRole("tab", { name: "Scene", exact: true }).waitFor();
  await page.evaluate(async () => {
    const resource = performance
      .getEntriesByType("resource")
      .find((entry) => entry.name.includes("/src/scene/SceneRenderer.ts"));
    const { SceneRenderer } = await import(resource.name);
    const render = SceneRenderer.prototype.render;
    window.sceneFrames = 0;
    SceneRenderer.prototype.render = function (...args) {
      const result = render.apply(this, args);
      window.sceneRuntime = this;
      window.sceneFrames++;
      return result;
    };
  });
  await page.waitForTimeout(350);
  const sample = () =>
    page.locator("canvas.webgl-preview").evaluate((canvas) => {
      const gl = canvas.getContext("webgl2");
      const p = new Uint8Array(4);
      gl.readPixels(
        Math.floor(canvas.width / 2),
        Math.floor(canvas.height / 2),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        p,
      );
      return [...p];
    });
  const raw = await sample();
  console.log("Raw pixel", raw);
  assert(raw[0] > 100 && raw[1] < 10 && raw[2] < 10);
  await page.evaluate(() => {
    window.originalSphere = window.sceneRuntime.entities.get("sphere").object;
    window.originalGeometry = window.originalSphere.geometry;
  });
  const sceneTransform = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  await page.getByRole("tab", { name: "Effects", exact: true }).click();
  await page.waitForTimeout(250);
  const final = await sample();
  console.log("Effects pixel", final);
  assert(final[1] > 100 && final[0] < 10 && final[2] < 10);
  assert.equal(await page.getByRole("checkbox", { name: "Enable effects" }).count(), 0);
  let exported;
  await page.route("**/api/local-patches", async (route) => {
    if (route.request().method() === "POST") {
      exported = JSON.parse(route.request().postDataJSON().patchJson);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Save patch to patches directory" })
    .click();
  assert.equal(exported.scene.nodes[0].kind, "Sphere");
  assert.equal(exported.effects.nodes[0].kind, "Scene");
  assert(
    await page.evaluate(
      () =>
        window.originalSphere ===
          window.sceneRuntime.entities.get("sphere").object &&
        window.originalGeometry === window.originalSphere.geometry,
    ),
  );
  const before = await page.evaluate(() => window.sceneFrames);
  await page.waitForTimeout(150);
  assert((await page.evaluate(() => window.sceneFrames)) > before);
  await page.getByRole("tab", { name: "Scene", exact: true }).click();
  await page.waitForTimeout(150);
  assert((await sample())[0] > 100);
  assert.equal(
    await page.locator(".react-flow__viewport").getAttribute("style"),
    sceneTransform,
  );
  await page.screenshot({ path: "/tmp/visual-visual-scene.png" });
  // Exercise persistent entities and GPU resources independently of React/editor state.
  const resources = await page.evaluate(async () => {
    const { sceneNodes, emptyScene } = await import("/src/scene/catalogue.ts");
    const runtime = window.sceneRuntime,
      graph = emptyScene();
    const sphere = sceneNodes.create("Sphere", { x: 0, y: 0 }, "resource-test");
    graph.nodes.push(sphere);
    runtime.render(graph, 128, 128, 10);
    const entity = runtime.entities.get(sphere.id),
      geometry = entity.object.geometry,
      texture = runtime.target.texture;
    sphere.values.positionX = 1;
    runtime.render(graph, 128, 128, 11);
    const stable =
      entity === runtime.entities.get(sphere.id) &&
      geometry === entity.object.geometry &&
      texture === runtime.target.texture;
    graph.nodes = [];
    runtime.render(graph, 128, 128, 12);
    return { stable, removed: runtime.entities.size === 0 && entity.disposed };
  });
  assert.deepEqual(resources, { stable: true, removed: true });
  const catalogueChecks = await page.evaluate(async () => {
    const { sceneNodes, emptyScene } = await import("/src/scene/catalogue.ts");
    const resource = performance
      .getEntriesByType("resource")
      .find((entry) => entry.name.includes("/src/scene/SceneRenderer.ts"));
    const { SceneRenderer } = await import(resource.name);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const gl = canvas.getContext("webgl2");
    const runtime = new SceneRenderer(gl, canvas);
    const graph = emptyScene();
    // Shadow controls also apply to existing patches without saved new values.
    for (const kind of ["Point Light", "Spot Light", "Directional Light"]) {
      const lightGraph = emptyScene();
      const shadowLight = sceneNodes.create(kind, { x: 0, y: 0 }, "shadow-light");
      shadowLight.data.shadows = true;
      shadowLight.data.shadowResolution = 512;
      shadowLight.values = { shadowStrength: 0.35, shadowSoftness: 3, shadowSize: 20 };
      lightGraph.nodes.push(shadowLight);
      runtime.render(lightGraph, 64, 64, 0);
      const lightObject = runtime.entities.get("shadow-light").object;
      if (!lightObject.castShadow || lightObject.shadow.intensity !== 0.35 ||
          lightObject.shadow.radius !== 3 || lightObject.shadow.mapSize.x !== 512 ||
          lightObject.shadow.normalBias !== 0.02)
        throw new Error(`${kind} shadow controls were not applied`);
      if (kind === "Directional Light" && lightObject.shadow.camera.right !== 10)
        throw new Error("Directional shadow coverage was not applied");
      shadowLight.data = { ...shadowLight.data, shadowResolution: 1024 };
      runtime.render(lightGraph, 64, 64, 0);
      if (runtime.entities.get("shadow-light").object === lightObject ||
          runtime.entities.get("shadow-light").object.shadow.mapSize.x !== 1024)
        throw new Error("Changing shadow resolution did not replace the shadow map");
    }
    const sphere = sceneNodes.create("Sphere", { x: 0, y: 0 }, "sphere");
    const light = sceneNodes.create("Ambient Light", { x: 0, y: 0 }, "ambient");
    light.values.intensity = 0;
    graph.nodes.push(sphere, light);
    const pixel = () => {
      const p = new Uint8Array(4);
      runtime.renderer.readRenderTargetPixels(runtime.target, 32, 32, 1, 1, p);
      return [...p];
    };
    runtime.render(graph, 64, 64, 0);
    const dark = pixel();
    light.values.intensity = 2;
    runtime.render(graph, 64, 64, 0.1);
    const lit = pixel();
    const camera = sceneNodes.create(
      "Perspective Camera",
      { x: 0, y: 0 },
      "camera",
    );
    camera.values.positionX = 10;
    graph.nodes.push(camera);
    runtime.render(graph, 64, 64, 0.2);
    const cameraPixel = pixel();
    for (const kind of [
      "Plane",
      "Box",
      "Cylinder",
      "Text",
      "Orthographic Camera",
      "Point Light",
      "Spot Light",
      "Fog",
      "Environment Map",
      "Render Settings",
    ]) {
      const g = emptyScene();
      g.nodes.push(sceneNodes.create(kind, { x: 0, y: 0 }, kind));
      runtime.render(g, 64, 64, 0.3);
    }
    const { storeAsset } = await import("/src/scene/assets.ts");
    const image = document.createElement("canvas");
    image.width = image.height = 8;
    const ctx = image.getContext("2d");
    ctx.fillStyle = "#00ffff";
    ctx.fillRect(0, 0, 8, 8);
    const blob = await new Promise((resolve) => image.toBlob(resolve));
    const url = await storeAsset(
      new File([blob], "texture.png", { type: "image/png" }),
    );
    const imageNode = sceneNodes.create("Image", { x: 0, y: 0 }, "image");
    imageNode.data.url = url;
    const imageGraph = emptyScene();
    imageGraph.nodes.push(imageNode);
    runtime.render(imageGraph, 64, 64, 0.4);
    await new Promise((resolve) => setTimeout(resolve, 200));
    runtime.render(imageGraph, 64, 64, 0.5);
    const imagePixel = pixel();
    const assetErrors = runtime.errors;
    runtime.dispose();
    return { dark, lit, cameraPixel, imagePixel, assetErrors };
  });
  assert(
    catalogueChecks.lit[0] > catalogueChecks.dark[0] + 50,
    "Light nodes illuminate standard materials",
  );
  assert(catalogueChecks.cameraPixel[0] < 10, "Camera node changes viewpoint");
  assert(
    catalogueChecks.imagePixel[0] < 10 &&
      catalogueChecks.imagePixel[1] > 100 &&
      catalogueChecks.imagePixel[2] > 100,
    "Local image asset renders through a GPU texture",
  );
  assert.deepEqual(catalogueChecks.assetErrors, []);

  // Use an asymmetric scene to distinguish absolute coordinates from implicit UV offsets.
  const sampling = await page.evaluate(async () => {
    const resource = performance.getEntriesByType("resource").find((e) => e.name.includes("/src/scene/SceneRenderer.ts"));
    const { SceneRenderer } = await import(resource.name);
    const { sceneNodes, emptyScene } = await import("/src/scene/catalogue.ts");
    const { compilePatchToGlsl } = await import("/src/graph/glsl.ts");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const gl = canvas.getContext("webgl2");
    const runtime = new SceneRenderer(gl, canvas);
    const graph = emptyScene();
    const camera = sceneNodes.create("Orthographic Camera", { x: 0, y: 0 }, "camera");
    camera.values.size = 4;
    const background = sceneNodes.create("Background", { x: 0, y: 0 }, "background");
    background.values.colourR = background.values.colourG = background.values.colourB = 0;
    graph.nodes.push(camera, background);
    for (const [id, x, y, colour] of [["red", -1, 1, "R"], ["green", 1, 1, "G"], ["blue", -1, -1, "B"]]) {
      const plane = sceneNodes.create("Plane", { x: 0, y: 0 }, id);
      plane.data.material = "basic";
      Object.assign(plane.values, { positionX: x, positionY: y, colourR: 0, colourG: 0, colourB: 0, [`colour${colour}`]: 1 });
      graph.nodes.push(plane);
    }
    const texture = runtime.render(graph, 64, 64, 0);
    const shader = (type, code) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, code);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const vertex = shader(gl.VERTEX_SHADER, `#version 300 es
      void main() {
        vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }`);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, 64, 64);
    for (const state of [gl.DEPTH_TEST, gl.BLEND, gl.CULL_FACE, gl.SCISSOR_TEST]) gl.disable(state);
    const results = {};
    for (const mode of ["identity", "flipX", "flipY", "fixed", "edge", "default"]) {
      const patch = {
        nodes: [
          { id: "coords", type: "System", params: {} },
          { id: "scene", type: "Scene", params: mode === "fixed" ? { x: 0.25, y: 0.75 } : mode === "edge" ? { x: -1, y: 2 } : {} },
          { id: "out", type: "Output", params: {} },
        ],
        links: ["r", "g", "b"].map((port) => ({ from: { node: "scene", port }, to: { node: "out", port } })),
      };
      if (["identity", "flipX", "flipY"].includes(mode)) for (const axis of ["x", "y"]) {
        const flip = mode === `flip${axis.toUpperCase()}`;
        patch.nodes.push({ id: axis, type: "Expression", expression: flip ? "1-a" : "a", inputs: [{ name: "a" }], params: {} });
        patch.links.push(
          { from: { node: "coords", port: axis }, to: { node: axis, port: "a" } },
          { from: { node: axis, port: "value" }, to: { node: "scene", port: axis } },
        );
      }
      const compiled = compilePatchToGlsl(patch, "webgl2");
      if (!compiled.ok) throw new Error(compiled.errors.join("; "));
      const fragment = shader(gl.FRAGMENT_SHADER, compiled.shaderCode);
      const program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      gl.uniform2f(gl.getUniformLocation(program, "u_resolution"), 64, 64);
      for (const arg of compiled.shaderArgs) gl.uniform1f(gl.getUniformLocation(program, arg.name), arg.value);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(gl.getUniformLocation(program, "u_scene"), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      results[mode] = [[16, 48], [48, 48], [16, 16], [48, 16]].map(([x, y]) => {
        const pixel = new Uint8Array(4);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return [...pixel].slice(0, 3).map((value) => value > 100 ? 1 : 0);
      });
      gl.deleteProgram(program);
      gl.deleteShader(fragment);
    }
    gl.deleteVertexArray(vao);
    gl.deleteShader(vertex);
    runtime.dispose();
    return results;
  });
  const red = [1, 0, 0], green = [0, 1, 0], blue = [0, 0, 1], black = [0, 0, 0];
  assert.deepEqual(sampling, {
    identity: [red, green, blue, black],
    flipX: [green, red, black, blue],
    flipY: [blue, black, red, green],
    fixed: [red, red, red, red],
    edge: [red, red, red, red],
    default: [blue, blue, blue, blue],
  });

  await page.waitForTimeout(100);
  // Browser context recovery rebuilds GPU objects and resumes the one pipeline.
  await page.evaluate(() => {
    const gl = document
      .querySelector("canvas.webgl-preview")
      .getContext("webgl2");
    const extension = gl.getExtension("WEBGL_lose_context");
    window.contextExtension = extension;
    extension.loseContext();
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => window.contextExtension.restoreContext());
  await page.waitForTimeout(600);
  assert((await sample())[0] > 100);
  assert.equal(await page.locator(".webgl-error").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Scene XY/RGB sampling, flips, fixed coordinates, edge clamping, live tabs and resource lifecycle passed.",
  );
} finally {
  await browser.close();
}
