# Visual Visual → Spagbol 0.1.1

**Release update (9 November 2026): Visual Visual now pins the published `@pauloricca/spagbol@0.1.1` package.** A clean registry-backed install matches all 123 built files of the tested release. The original 0.1.0 measurements below remain for comparison; the fix measurements are in [the local fix results](#local-spagbol-drag-fix), with registry verification recorded in [release-0.1.1.json](release-0.1.1.json).

With the original published package, the migration is implemented and functional, but **the no-performance-regression gate does not pass for larger graphs**. The seven-node demo retains its frame rate and main-thread CPU use. The 107-node graph costs substantially more CPU and has higher pointer-to-frame latency. These initial results motivated the shared-package fix recorded below.

## What changed

Visual Visual now uses the published `@pauloricca/spagbol@0.1.1` package and its required React Flow 12.11 peer. The shared canvas/controller owns node creation, movement, selection, connections, cable controls/reconnection/insertion, copy/paste/duplication, grouping, nesting, numeric gestures, zoom, history and menus. Local ShaderNode, ShaderEdge, EdgeOverlayContext and flowPatch implementations were removed, along with their graph styling.

App code retains the shader catalogue, legacy patch codec and validation, expression content, scope/meter/MIDI content, WebGL execution, projector synchronization and storage dialogs. Existing patch JSON remains supported. Version 1 browser state is converted to the shared graph model; the original key remains untouched, with new state saved under `visual-visual.editor-state.v2`.

Layout gestures no longer trigger shader recompilation or projector publishing. Viewport persistence is debounced. Runtime MIDI values remain separate from undo/history. Scopes render into their own canvas surface so cables cannot cross over the image.

## Matched production measurements

Chrome **156.0.8078.80**, headless, on this Mac, device scale 1, active WebGL/Metal preview. Baseline commit: `0e409ecfa6614ff0bc27bde8bffab6484aaf5ed3`. Both builds use the same installed React/React Flow/Vite versions. Three fresh browser contexts per case, 700ms warm-up, one 120-step out-and-back node-header drag followed by 20 alternating horizontal wheel events. The same node positions, link settings, viewport and shader are seeded through legacy browser state in both apps.

Numbers are medians of three runs. CPU is Chrome's `Performance.TaskDuration` delta for the entire interaction sequence. Latency is the p95 interval from a document capture listener receiving a pointer event to its next animation-frame callback. It includes handler/scheduling time; it is **not INP**, a GPU timing measurement, or a hardware input latency measurement. Browser automation influences scheduling, so relative comparisons within this setup matter more than absolute timings.

| Window | Nodes / links | Main-thread CPU before → after | Pointer-to-next-frame p95 before → after | Frame interval p95 before → after |
| --- | --- | --- | --- | --- |
| 1440 × 900 | 7 / 8 | 0.602s → 0.627s | 0.50ms → 4.32ms | 16.67ms → 16.67ms |
| 1440 × 900 | 107 / 107 | 0.605s → 2.368s | 1.32ms → 16.24ms | 16.67ms → 16.67ms |
| 800 × 900 | 7 / 8 | 0.587s → 0.595s | 0.38ms → 4.71ms | 16.67ms → 16.67ms |
| 800 × 900 | 107 / 107 | 0.517s → 1.784s | 1.72ms → 12.46ms | 16.67ms → 16.67ms |

All runs had no page errors. Baseline recorded no long tasks; the large migrated cases recorded long tasks (see per-run counts in the raw data). The shared canvas virtualizes offscreen content: on the narrow large-graph case it rendered 77 of 107 nodes, while the old editor rendered all 107. That optimization does not erase the interaction regression.

First-node readiness medians: 139→145ms (desktop demo), 272→277ms (desktop large), 142→136ms (narrow demo), 277→234ms (narrow large). These short local loads are noisy and are not network-loading benchmarks. Heap snapshots are included in raw data but are not retained-memory measurements; garbage collection was not forced.

Production bundle: JavaScript 564.30→581.77kB uncompressed and 169.72→179.65kB gzip; CSS 37.65→46.15kB and 6.43→8.03kB gzip. Spagbol includes shared capabilities beyond those enabled in this app.

Raw results: [before](production-before/metrics.json), [after](production-final/metrics.json). The initial development-mode [before](before/metrics.json) and [after](after/metrics.json) measurements capture the original fit-to-view demo and picker. The production table above is the performance decision source.

## Screenshot comparison

Each production pair uses identical persisted graph positions and viewport. The WebGL demo is time-dependent, so differences in background animation phase are not graph-renderer regressions.

| Scenario | Before | After |
| --- | --- | --- |
| Desktop demo | [Screenshot](production-before/1440-7-graph.png) | [Screenshot](production-final/1440-7-graph.png) |
| Desktop 107 nodes | [Screenshot](production-before/1440-107-graph.png) | [Screenshot](production-final/1440-107-graph.png) |
| Narrow demo | [Screenshot](production-before/800-7-graph.png) | [Screenshot](production-final/800-7-graph.png) |
| Narrow 107 nodes | [Screenshot](production-before/800-107-graph.png) | [Screenshot](production-final/800-107-graph.png) |
| Original default fit, desktop | [Screenshot](before/1440-default.png) | [Screenshot](after/1440-default.png) |
| Node picker, desktop | [Screenshot](before/1440-picker.png) | [Screenshot](after/1440-picker.png) |
| Original default fit, narrow | [Screenshot](before/800-default.png) | [Screenshot](after/800-default.png) |
| Node picker, narrow | [Screenshot](before/800-picker.png) | [Screenshot](after/800-picker.png) |

Observed UI differences:

- Spagbol uses round, smaller ports, different node minimum widths and row spacing, and smaller numeric controls. System output labels align differently. Auto-fit therefore chooses a different zoom and placement when no viewport was saved; saved viewports are retained.
- Inputs with a replacing `set` connection show their stored value dimmed. Header output ports remain supported.
- A faint shared dot grid appears over the shader background. The percentage/reset zoom button is new; the FPS badge sits beside the shared zoom stack.
- The picker is now Spagbol's searchable catalogue. Cancelling creation does not leave a typeless placeholder. Already-saved typeless wire passthroughs are materialized during legacy state conversion.
- The More menu is the shared accessible menu and adds scale/lock actions. The app supplies save/load, import, fullscreen, visual/UI toggles and screenshot actions. Root patch name stays separate from the subpatch-name field while editing a group.
- Group boundaries use stable IDs internally and human-readable labels in exported patches. Enter through the header arrow or double-click the group body; return through Exit/breadcrumbs.
- Scope and meter widgets use shared frames/ports and remain app-owned content: [scope/meter screenshot](smoke/custom.png), [group screenshot](smoke/group.png).
- Subpatch import now selects a saved patch/version, then a contained subpatch, rather than aggregating all saved subpatches into a single catalogue.

## Package follow-ups

1. **Performance, required:** reduce whole-document/React Flow work during layout-only drags. A development CPU profile is saved as [profile.cpuprofile](profile.cpuprofile). It shows React Flow store/selector churn, React rendering/allocation and repeated connection validation during drags. These are profile observations, not proof that one function alone explains the production regression. Spagbol currently calls graph validation on each new document snapshot and performs an atomic graph edit on each node-position notification. Consider transient drag presentation with one commit, cached diagnostics for layout-only updates and narrower subscriptions.
2. **Capability flags:** the high-level shared frame/link controls expose enable/disable actions unconditionally. Visual Visual's patch contract has no mute state. This migration hides those buttons, blocks the X shortcut outside fields, and normalizes enabled fields away. A shared capability flag would remove that host workaround.
3. **Connection audition:** the old editor compiled temporary connection/reconnection hover candidates. The high-level shared canvas does not expose those candidates to the host; the shader now changes when a connection is dropped. An optional preview callback would restore live audition without storing temporary connections.
4. **Port insertion gesture:** the old double-click-on-pin insertion shortcut is absent from the shared port primitive. Spagbol retains double-click cable insertion and Cmd/Ctrl-drop connected-node creation. Add a shared pin-insertion gesture/API for exact shortcut parity.

The initial migration did not change Spagbol. The subsequent performance fix was implemented in the shared repository and is now published as 0.1.1; no consumer-side fork or copied replacement canvas was introduced.

## Validation and reproduction

`npm test` passes 109 checks in this workspace: exact complete compiler-result and validation equality for all 100 existing patch versions plus three committed fixtures, catalogue coverage, nested grouping/history, expression topology/undo, MIDI separation and legacy state import. On a fresh checkout the three committed fixture cases and the six adapter cases run without requiring the ignored local patch library.

`npm run typecheck` and `npm run build` pass. Browser checks cover node creation/deletion, undo/redo, grouping, nested naming, numeric changes and undo, cable mode selection, a scope pixel readback, meter values and a mocked save request. Physical MIDI, mic, camera and external projector hardware were not exercised.

Run Chrome-based checks with an installed Chrome path (the scripts default to macOS Google Chrome):

```sh
npm ci
npm test
npm run dev
# In another terminal:
node benchmarks/smoke.mjs
node benchmarks/graph-ui.mjs after
```

For production comparisons, build the original commit in a separate temporary directory and serve its `web` preview on port 5174. Serve this build's preview on 5175, then run sequentially with no builds or other browser tests during collection:

```sh
node benchmarks/compare.mjs production-before http://127.0.0.1:5174
node benchmarks/compare.mjs production-final http://127.0.0.1:5175
```

`CHROME_PATH` selects another Chrome executable. Do not rebuild a server's output during a run; doing so can remove hashed assets still requested by a fresh browser context. Large graphs may have fewer rendered DOM nodes because of virtualization; the runner checks the persisted graph's node count independently.

## Local Spagbol drag fix

The fix lives in the sibling Spagbol repository (`src/react/SpagbolCanvas.tsx` and internal `src/react/nodeDrag.ts`). It also narrows selection subscriptions in `SpagbolNodeFrame.tsx`: frames and ports observe only their own relevant selection state, and an unused whole-selection subscription in the node-view command hook was removed. It does not replace the controller or introduce a consumer-side workaround. Native React Flow positions provide the transient drag preview; a small map records the eventual positions. Drop applies one layout edit for all moved nodes. Cancellation discards the preview and explicitly refreshes controlled geometry. Canvas subscriptions to all live native node records are now limited to the cable-property anchor feature that needs them. Measured-size notifications still invalidate pan bounds.

The `GraphEditor.edit()` deep clone is real, and restoring references afterwards does not avoid that allocation. However, the isolated Node benchmark measured about 50ms for 120 edits at 107 nodes, and roughly 457–479ms at 1000 nodes. JSON stringification alone accounted for approximately 6ms and 57–58ms respectively; those are not complete clone timings. Removing document edits from every pointer movement improved latency, but a state-based drag preview still used about 2.03s of combined CPU. Removing the redundant controlled-position feedback and unnecessary broad native-node subscription brought CPU down to about 0.47s in the final run. The evidence supports fixing the drag lifecycle rather than attributing the whole regression to JSON serialization alone.

The isolated benchmark is preserved in Spagbol as `scripts/benchmark-edits.mjs`. Generic edits, including live numeric/slider edits, still use the existing controller implementation. This fix addresses node movement; it does not claim to eliminate copy costs from every graph operation.

Final production results use the same locked dependencies, Chrome version, fixtures and 3-run protocol as above. No other browser checks or builds ran during collection. [Raw fixed results](spagbol-fixed/metrics.json), [fresh original-editor recheck](original-recheck/metrics.json), [new drag browser regression test](drag-regression.mjs). The runner now records drag and pan CPU separately in addition to the existing combined total.

| Window | Nodes | Published Spagbol CPU → fixed CPU | Published pointer p95 → fixed pointer p95 | Fixed drag CPU / pan CPU |
| --- | --- | --- | --- | --- |
| 1440 × 900 | 7 | 0.627s → 0.260s | 4.32ms → 0.55ms | 0.173s / 0.085s |
| 1440 × 900 | 107 | 2.368s → 0.468s | 16.24ms → 0.70ms | 0.318s / 0.124s |
| 800 × 900 | 7 | 0.595s → 0.277s | 4.71ms → 0.56ms | 0.200s / 0.077s |
| 800 × 900 | 107 | 1.784s → 0.435s | 12.46ms → 0.61ms | 0.300s / 0.125s |

All fixed cases retain a 16.67ms p95 frame interval. Spagbol's Docker suite passes 61 tests; Visual Visual's 109 compatibility checks pass. Browser tests verify native geometry and saved state across drop, undo/redo, Escape (including late pointer motion), pointer cancellation, multi-selection, and Alt duplication. The regression runner also asserts zero full-graph JSON serializations while dragging and one clone plus the two existing gesture comparisons at drop.

The package was built and packed through Spagbol's Docker workflow. Those original performance tests used a tarball unpacked over the installed dependency. On 9 November 2026, the same build was published as 0.1.1, and Visual Visual's manifest and registry-backed lockfile were updated. A subsequent `npm ci` installed 0.1.1 from npm, with all built-file hashes matching the tested artifact. The fixed screenshots use identical graph/viewport fixtures and are under `spagbol-fixed/`.

Compared with the fresh original-editor recheck, the fixed combined CPU medians are lower in all four cases. Drag-only CPU is not uniformly lower: the final large narrow case is about 0.300s versus 0.228s originally, while pan CPU is 0.125s versus 0.240s. Pointer p95 is below 1ms in all fixed cases; treat these automation timings as comparative measurements. Long tasks and worst-frame intervals remain in the raw data rather than being hidden by p95 summaries.

## Registry release validation

Spagbol 0.1.1 was committed and pushed as `43e613cb685533c6812f97cc22b35c9ea9d1ed44`, tagged `v0.1.1`, and published to the public npm registry. Visual Visual declares an exact `0.1.1` dependency. Its lockfile points to the registry tarball with the verified release integrity; it no longer relies on the temporary package overlay. A clean install, type check, 109 compatibility tests and production build pass against this package. Runtime checks use a fresh Vite server with dependency optimization forced.
