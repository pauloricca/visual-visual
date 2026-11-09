import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "visual-visual-tests-"));
try {
  const outfile = join(directory, "tests.mjs");
  await build({
    entryPoints: ["tests/patchCodec.test.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    external: ["node:*"],
  });
  const result = spawnSync(process.execPath, ["--test", outfile], {
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
