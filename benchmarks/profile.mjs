import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { fixture } from "./fixtures.mjs";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-gl=angle", "--use-angle=metal"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
await page.addInitScript(
  (seed) =>
    localStorage.setItem("visual-visual.editor-state.v1", JSON.stringify(seed)),
  fixture(107),
);
await page.goto(`${process.env.BENCH_URL ?? "http://localhost:5173"}/?app-id=Profl`);
await page.waitForTimeout(1500);
const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.start");
const box = await page
  .locator(".react-flow__node")
  .filter({ hasText: "Multiply" })
  .first()
  .boundingBox();
await page.mouse.move(box.x + box.width * 0.4, box.y + 9);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.4 + 70, box.y + 49, { steps: 100 });
await page.mouse.up();
const { profile } = await cdp.send("Profiler.stop");
await writeFile(process.env.PROFILE_PATH ?? "benchmarks/profile.cpuprofile", JSON.stringify(profile));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const weights = new Map();
for (let i = 0; i < profile.samples.length; i++)
  weights.set(
    profile.samples[i],
    (weights.get(profile.samples[i]) ?? 0) + profile.timeDeltas[i],
  );
console.log(
  [...weights]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([id, time]) => ({
      timeMs: time / 1000,
      function: byId.get(id).callFrame.functionName,
      url: byId.get(id).callFrame.url,
      line: byId.get(id).callFrame.lineNumber,
    })),
);
await browser.close();
