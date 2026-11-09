import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-gl=angle", "--use-angle=metal", "--enable-webgl"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await mkdir("benchmarks/smoke", { recursive: true });
await page.goto(`${process.env.BENCH_URL ?? "http://localhost:5173"}/?app-id=Smoke`);
await page.locator(".spagbol-node-frame").first().waitFor();
await page.waitForTimeout(500);
assert.equal(await page.locator(".react-flow__node").count(), 7);
await page.mouse.dblclick(400, 720);
await page.getByPlaceholder("Search nodes…").fill("Constant");
await page.keyboard.press("Enter");
await page.waitForTimeout(100);
assert.equal(await page.locator(".react-flow__node").count(), 8);
await page.getByRole("button", { name: "Undo", exact: true }).click();
assert.equal(await page.locator(".react-flow__node").count(), 7);
await page.getByRole("button", { name: "Redo", exact: true }).click();
assert.equal(await page.locator(".react-flow__node").count(), 8);
const node = page.locator(".react-flow__node").filter({ hasText: "Constant" });
await node.click();
await page.keyboard.press("Backspace");
assert.equal(await page.locator(".react-flow__node").count(), 7);
await page.getByRole("button", { name: "More actions" }).click();
await page.getByRole("menuitemcheckbox", { name: "Toggle GLSL panel" }).click();
assert.equal(await page.locator(".export-panel").count(), 0);
await page.getByRole("button", { name: "More actions" }).click();
await page.getByRole("menuitemcheckbox", { name: "Toggle GLSL panel" }).click();
const multiply = page
  .locator(".react-flow__node")
  .filter({ hasText: "Multiply" })
  .first();
await multiply.locator(".spagbol-node-frame-header").click();
await page.keyboard.down("Shift");
await page
  .locator(".react-flow__node")
  .filter({ hasText: "Sin" })
  .first()
  .locator(".spagbol-node-frame-header")
  .click();
await page.keyboard.up("Shift");
await page.getByRole("button", { name: "More actions" }).click();
await page
  .getByRole("menuitem", { name: "Group to subpatch", exact: true })
  .click();
await page.waitForTimeout(150);
assert.equal(await page.locator(".react-flow__node").count(), 6);
await page
  .getByRole("button", { name: "Enter nested graph", exact: true })
  .click();
await page.waitForTimeout(100);
assert.equal(await page.locator(".react-flow__node").count(), 4);
await page
  .getByRole("textbox", { name: "Subpatch name", exact: true })
  .fill("Test group");
await page
  .getByRole("button", { name: "Exit nested graph", exact: true })
  .click();
assert.equal(
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "Test group" })
    .count(),
  1,
);
await page.screenshot({ path: "benchmarks/smoke/group.png" });
// Browser upload uses the same validated patch format as local storage.
await context.close();
const second = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const p = await second.newPage();
p.on("pageerror", (e) => errors.push(e.message));
const patch = {
  name: "custom nodes",
  nodes: [
    { id: "system", type: "System", params: {}, position: { x: 20, y: 100 } },
    {
      id: "expression",
      type: "Expression",
      expression: "a*2.0",
      params: { a: 0.25 },
      position: { x: 250, y: 100 },
    },
    {
      id: "scope",
      type: "Scope",
      params: { value: 0 },
      position: { x: 500, y: 100 },
    },
    {
      id: "meter",
      type: "Meter",
      params: { value: 0 },
      position: { x: 500, y: 350 },
    },
    {
      id: "output",
      type: "Output",
      params: { r: 0, g: 0, b: 0 },
      position: { x: 800, y: 200 },
    },
  ],
  links: [
    {
      from: { node: "expression", port: "value" },
      to: { node: "scope", port: "value" },
    },
    {
      from: { node: "expression", port: "value" },
      to: { node: "meter", port: "value" },
    },
    {
      from: { node: "expression", port: "value" },
      to: { node: "output", port: "r" },
    },
  ],
};
await p.addInitScript((patch) => {
  localStorage.setItem(
    "visual-visual.editor-state.v1",
    JSON.stringify({
      version: 1,
      nodes: patch.nodes,
      edges: patch.links.map((l, i) => ({
        id: `l${i}`,
        source: l.from.node,
        sourceHandle: `out:${l.from.port}`,
        target: l.to.node,
        targetHandle: `in:${l.to.port}`,
      })),
    }),
  );
}, patch);
await p.goto(`${process.env.BENCH_URL ?? "http://localhost:5173"}/?app-id=Smoke`);
await p.locator("[data-meter-min]").waitFor();
await p.waitForTimeout(1000);
console.log("meter", await p.locator("[data-meter-min]").textContent());
assert.notEqual(await p.locator("[data-meter-min]").textContent(), "--");
assert.equal(await p.locator(".status-ok").count(), 1);
assert.equal(
  await p
    .locator("canvas[data-scope-node-id]")
    .evaluate(
      (canvas) => canvas.getContext("2d").getImageData(10, 10, 1, 1).data[0],
    ),
  128,
);
await p.getByRole("spinbutton", { name: "Expression: a", exact: true }).click();
await p
  .getByRole("textbox", { name: "Expression: a", exact: true })
  .fill("0.75");
await p.keyboard.press("Enter");
await p.waitForFunction(
  () => document.querySelector("[data-meter-min]")?.textContent === "1.500",
);
await p.getByRole("button", { name: "Undo", exact: true }).click();
await p.waitForFunction(
  () => document.querySelector("[data-meter-min]")?.textContent === "0.500",
);
// Select a cable at its actual Bezier midpoint and edit the shared mode control.
const midpoint = await p
  .locator(".react-flow__edge-interaction")
  .first()
  .evaluate((path) => {
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(
      path.getScreenCTM(),
    );
    return { x: screen.x, y: screen.y };
  });
await p.mouse.click(midpoint.x, midpoint.y);
await p.waitForFunction(() => document.querySelectorAll(".spagbol-node-port-selected-link").length === 2);
await p.getByLabel("Link mode", { exact: true }).selectOption("multiply");
await p.getByRole("button", { name: "Undo", exact: true }).click();
await p.mouse.click(950, 750);
let saved;
await p.route("**/api/local-patches", async (route) => {
  if (route.request().method() === "POST") {
    saved = JSON.parse(route.request().postData()).patchJson;
    await route.fulfill({ status: 201, body: "{}" });
  } else await route.continue();
});
await p
  .getByRole("button", { name: "Save patch to patches directory", exact: true })
  .click();
assert.equal(JSON.parse(saved).nodes.length, 5);
assert.equal(JSON.parse(saved).links.length, 3);
await p.screenshot({ path: "benchmarks/smoke/custom.png" });
assert.deepEqual(errors, []);
console.log("Smoke checks passed");
await browser.close();
