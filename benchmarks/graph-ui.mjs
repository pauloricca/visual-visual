import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
const label = process.argv[2] || "before";
const out = new URL(`./${label}/`, import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-gl=angle", "--use-angle=metal", "--enable-webgl"],
});
const results = [];
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 800, height: 900 },
]) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__frames = [];
    window.__long = [];
    let last;
    function frame(t) {
      if (last) window.__frames.push(t - last);
      last = t;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    new PerformanceObserver((l) =>
      window.__long.push(...l.getEntries().map((e) => e.duration)),
    ).observe({ type: "longtask", buffered: true });
  });
  const start = Date.now();
  await page.goto("http://localhost:5173/?app-id=Bench");
  await page.locator(".react-flow__node").first().waitFor();
  const readyMs = Date.now() - start;
  await page.waitForTimeout(2000);
  await page.screenshot({
    path: new URL(`${viewport.width}-default.png`, out).pathname,
  });
  const metrics = await page.evaluate(async () => {
    window.__frames = [];
    window.__long = [];
    await new Promise((r) => setTimeout(r, 2000));
    const f = window.__frames.slice().sort((a, b) => a - b);
    return {
      frameMedianMs: f[Math.floor(f.length * 0.5)],
      frameP95Ms: f[Math.floor(f.length * 0.95)],
      frames: f.length,
      longTasks: window.__long.length,
      longTaskMs: window.__long.reduce((a, b) => a + b, 0),
      nodes: document.querySelectorAll(".react-flow__node").length,
      edges: document.querySelectorAll(".react-flow__edge").length,
      heapBytes: performance.memory?.usedJSHeapSize,
    };
  });
  const node = page.locator(".react-flow__node").first();
  const box = await node.boundingBox();
  const drag = [];
  for (let n = 0; n < 8; n++) {
    const t = Date.now();
    await page.mouse.move(box.x + box.width / 2, box.y + 15);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + 35, {
      steps: 12,
    });
    await page.mouse.up();
    drag.push(Date.now() - t);
    await page.keyboard.press("Meta+z");
  }
  const panStart = Date.now();
  for (let n = 0; n < 20; n++) {
    await page.mouse.move(300, 450);
    await page.mouse.wheel(n % 2 ? -30 : 30, 0);
  }
  const panMs = Date.now() - panStart;
  await page.reload();
  await page.locator(".react-flow__node").first().waitFor();
  await page.waitForTimeout(1000);
  await page.mouse.dblclick(400, viewport.width === 800 ? 450 : 700);
  await page.waitForTimeout(200);
  await page.screenshot({
    path: new URL(`${viewport.width}-picker.png`, out).pathname,
  });
  results.push({
    viewport,
    readyMs,
    ...metrics,
    dragMedianMs: drag.sort((a, b) => a - b)[4],
    pan20EventsMs: panMs,
    errors,
  });
  await context.close();
}
await writeFile(
  new URL("metrics.json", out),
  JSON.stringify({ label, browser: browser.version(), results }, null, 2),
);
console.log(JSON.stringify(results, null, 2));
await browser.close();
