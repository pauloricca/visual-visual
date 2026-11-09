import { fixture } from "./fixtures.mjs";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const label = process.argv[2];
const base = process.argv[3];
if (!label || !base)
  throw new Error("Usage: node benchmarks/compare.mjs <label> <url>");
const out = new URL(`./${label}/`, import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-gl=angle", "--use-angle=metal", "--enable-webgl"],
});
const all = process.env.RESUME
  ? JSON.parse(await readFile(new URL("metrics.json", out), "utf8")).results
  : [];
for (const width of (process.env.WIDTH ? [Number(process.env.WIDTH)] : [1440, 800]))
  for (const count of (process.env.NODES ? [Number(process.env.NODES)] : [7, 107]))
    for (let run = 0; run < Number(process.env.RUNS ?? 3); run++) {
      if (
        all.some((r) => r.width === width && r.count === count && r.run === run)
      )
        continue;
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript((seed) => {
        localStorage.setItem(
          "visual-visual.editor-state.v1",
          JSON.stringify(seed),
        );
        window.__frames = [];
        window.__latency = [];
        window.__long = [];
        window.__measure = false;
        let last;
        function frame(t) {
          if (window.__measure && last) window.__frames.push(t - last);
          last = t;
          requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
        document.addEventListener(
          "pointermove",
          () => {
            if (!window.__measure) return;
            const start = performance.now();
            requestAnimationFrame(() =>
              window.__latency.push(performance.now() - start),
            );
          },
          true,
        );
        new PerformanceObserver((list) => {
          if (window.__measure)
            window.__long.push(...list.getEntries().map((e) => e.duration));
        }).observe({ type: "longtask", buffered: true });
      }, fixture(count));
      const start = Date.now();
      await page.goto(`${base}/?app-id=Bench`);
      await page.locator(".react-flow__node").first().waitFor();
      await page.waitForFunction((n) => {
        const state = JSON.parse(
          localStorage.getItem("visual-visual.editor-state.v2") ??
            localStorage.getItem("visual-visual.editor-state.v1"),
        );
        return (state.document?.nodes ?? state.nodes).length === n;
      }, count);
      const readyMs = Date.now() - start;
      await page.waitForTimeout(700);
      if (run === 0)
        await page.screenshot({
          path: new URL(`${width}-${count}-graph.png`, out).pathname,
        });
      const cdp = await context.newCDPSession(page);
      await cdp.send("Performance.enable");
      const before = await cdp.send("Performance.getMetrics");
      await page.evaluate(() => {
        window.__measure = true;
      });
      const target = page
        .locator(".react-flow__node")
        .filter({ hasText: "Multiply" })
        .first();
      const b = await target.boundingBox();
      await page.mouse.move(b.x + b.width * 0.4, b.y + 9);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width * 0.4 + 70, b.y + 49, { steps: 60 });
      await page.mouse.move(b.x + b.width * 0.4, b.y + 9, { steps: 60 });
      await page.mouse.up();
      const afterDrag = await cdp.send("Performance.getMetrics");
      await page.mouse.move(width * 0.7, 450);
      for (let i = 0; i < 20; i++) await page.mouse.wheel(i % 2 ? -25 : 25, 0);
      const measured = await page.evaluate(() => {
        window.__measure = false;
        const summary = (a) => {
          const v = a.slice().sort((a, b) => a - b);
          return {
            median: v[Math.floor(v.length * 0.5)] ?? 0,
            p95: v[Math.floor(v.length * 0.95)] ?? 0,
            max: v.at(-1) ?? 0,
            count: v.length,
          };
        };
        return {
          frames: summary(window.__frames),
          pointerToFrameMs: summary(window.__latency),
          longTasks: window.__long.length,
          longTaskMs: window.__long.reduce((a, b) => a + b, 0),
          heapBytes: performance.memory?.usedJSHeapSize,
        };
      });
      const after = await cdp.send("Performance.getMetrics");
      const delta = {};
      for (const name of [
        "TaskDuration",
        "ScriptDuration",
        "LayoutDuration",
        "RecalcStyleDuration",
      ])
        delta[name] =
          after.metrics.find((m) => m.name === name).value -
          before.metrics.find((m) => m.name === name).value;
      const record = {
        width,
        count,
        visibleNodes: await page.locator(".react-flow__node").count(),
        run,
        readyMs,
        ...measured,
        cpuSeconds: delta,
        dragCpuSeconds: afterDrag.metrics.find(m => m.name === "TaskDuration").value - before.metrics.find(m => m.name === "TaskDuration").value,
        panCpuSeconds: after.metrics.find(m => m.name === "TaskDuration").value - afterDrag.metrics.find(m => m.name === "TaskDuration").value,
        errors,
      };
      all.push(record);
      await writeFile(
        new URL("metrics.json", out),
        JSON.stringify(
          {
            label,
            url: base,
            browser: browser.version(),
            timestamp: new Date().toISOString(),
            results: all,
          },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          label,
          width,
          count,
          run,
          frameP95: measured.frames.p95,
          latencyP95: measured.pointerToFrameMs.p95,
          cpu: delta.TaskDuration, dragCpu: record.dragCpuSeconds, panCpu: record.panCpuSeconds,
          errors,
        }),
      );
      await context.close();
    }
await writeFile(
  new URL("metrics.json", out),
  JSON.stringify(
    {
      label,
      url: base,
      browser: browser.version(),
      timestamp: new Date().toISOString(),
      results: all,
    },
    null,
    2,
  ),
);
await browser.close();
