# Scene and Effects

Visual Visual has one pipeline: Scene graph → offscreen scene texture → Effects shader → display. Scene shows the first texture behind its graph; Effects shows the processed output. The canvas stays mounted and its existing `requestAnimationFrame` loop drives both stages. Hiding visuals hides the canvas, without stopping time, feedback or video playback.

## Editing

New projects open in Scene with empty graphs. Double-click the graph background to add a Sphere, Box, Plane or another scene node. Objects exist without links. The default camera and fallback lighting make new geometry visible immediately. Adding light nodes replaces fallback lighting. Camera selection is in the Scene toolbar; automatic selection uses the first visible camera, falling back to the default camera.

All numeric properties are normal Spagbol float inputs. Rotations and cone angles use radians; camera field of view uses degrees. Geometry dimensions and positions use scene units. Non-numeric options, text, fonts and media references are node configuration.

Effects passes the scene through when there is no Output node. Add **Scene**, connect **Sys ins.x/y** to its **x/y** inputs, then connect its **r/g/b** float outputs to Output (or other shader nodes). The Effects graph runs for each output pixel; Scene returns the rendered scene's color at the supplied normalized coordinates. X runs left to right and Y bottom to top, from 0 to 1. Coordinates outside this range clamp to the nearest edge. Unconnected coordinates use their numeric values (default 0), so a constant pair samples the same scene pixel across the whole output. Transform the coordinates before Scene to warp, flip, zoom or repeat the image. The scene is rendered once per frame on the GPU and sampled per pixel; the texture itself never travels through a link. Saved Scene Render nodes are converted to Scene with explicit coordinate links, preserving their offsets through ordinary Add nodes. Legacy shader patches keep their shader output and open in Effects.

## Reused systems

- Both graphs use Spagbol's GraphEditor, SpagbolCanvas, ports, links, numeric gestures, nested graphs, selection and undo history. Each has an independent controller and viewport.
- Curve, Sequence, Slider, Button and Joystick reuse Spagbol's controlled UI components. The installed 0.1.3 package has no executable standard-node definitions or evaluator, so `scene/catalogue.ts` and `scene/evaluate.ts` provide the application adapter.
- The existing GLSL compiler still compiles Effects. Scene adds an XY sampler source with float RGB outputs.
- The existing WebGLPreview owns the only animation loop and background canvas. Three.js renders the persistent scene into a reusable render target in that same WebGL2 context. No scene pixels are copied through the CPU.
- Three.js and the shader renderer reset shared GL state at their boundary. The private texture-handle bridge is confined to SceneRenderer and Three.js is pinned to 0.187.0. Context restoration reconstructs GPU resources and resumes the loop.
- Existing browser/local-server save and load controls now write a version 2 project containing both Spagbol documents. Legacy patch JSON and v1/v2 browser shader state remain readable. The original legacy browser key remains untouched.

## Numeric execution profile

### Light shadows

Point, Spot and Directional lights have a Shadows toggle and a Shadow resolution selector (256–2048, default 1024). Higher resolution increases detail and GPU cost. Numeric shadow inputs can also be linked and animated:

- `shadowStrength`: darkness, clamped to 0–1 (default 1).
- `shadowSoftness`: filtering radius, clamped to 0–10 (default 2). Large values can introduce banding; this is filtered shadow mapping, not physical area-light softness.
- `shadowBias`: depth offset, default -0.0001; small adjustments suppress striping.
- `shadowNormalBias`: surface-normal offset in scene units, default 0.02. Too much can detach or distort shadows.
- `shadowNear` / `shadowFar`: shadow camera depth limits, default 0.5 / 500. Keep these around the relevant geometry; geometry outside them cannot cast shadows.
- `shadowSize`: Directional Light coverage width and height in scene units (default 10). Smaller coverage concentrates detail; it does not resize the physical shadow. Point and Spot coverage follows their projection; change light/object positions to change a cast shadow's size.

Render Settings retains the global shadows switch. Mesh Shadows controls both casting and receiving. Existing projects inherit the new light input defaults without migration.

This is a per-animation-frame profile of Spagbol's documented float model, rather than a claim of portable standard-node conformance. Set averages weighted sources, Add sums them, Multiply multiplies them, and Bend multiplies by `2^(source × weight)`, in that order. Link weights can themselves be modulated through normal Spagbol links. Disabled links are skipped. Non-finite arithmetic becomes zero. Feedback cycles read the preceding evaluation's pending port value. Delta time is capped at 0.1 seconds after a stalled frame.

The generic vocabulary contains Expression, Constant, Pass, Abs, Multiply, Pow, Map, Clamp, Selector, Conditional Execution, Spread, Spawn, Accumulator, Random, Noise, Slider, Button, Joystick, Curve and Sequence. Scene Time, Scene Playhead and Instance are application nodes.

- Expression uses a restricted numeric parser, never JavaScript evaluation. It supports arithmetic, power and common scalar maths functions; trigonometry uses radians. Invalid expressions yield zero. Its inferred symbols are float inputs.
- Selector has two stable inputs, a/b, with one-based latching select and slide in seconds. Invalid selections retain the previous selection.
- Accumulator supports trigger and continuous modes, reset precedence, sorted bounds and endpoint wrapping. Continuous increments once per executed frame, not once per second.
- Random draws initially and on trigger rises, holds a normalized draw and maps live min/max bounds. Its numeric seed input is an application extension. Noise draws once per executed frame. The deterministic sine-hash stream is not a cross-application PRNG guarantee.
- Slider and Joystick retain their shared normalized interaction models and expose numeric range mapping. Button supports temporary/toggle/trigger modes; trigger events queue up to 256 alternating high/low frame pulses. Temporary presses and queued trigger events reset when a project loads.
- Curve uses normalized position with linear interpolation. Sequence uses normalized position over 16 steps; its shared sequencer editor retains gate movement, resizing and level editing. This profile has one numeric row, represented by start/end/level intervals; gaps yield zero. Both support clamp/repeat/mirror boundaries. They have no internal clock.
- Scene Time reports elapsed pipeline seconds and frame delta. Scene Playhead provides independent speed, length, loop, playing and numeric reset controls. Runtime state is not saved as part of a project.

## Execution scopes and entities

Spread, Spawn and Conditional Execution use Spagbol nested graphs as their scope representation. Use the header arrow to enter a scope and add nodes there. Add **Instance** inside it to expose index, count, age and gate as floats. Scope boundaries cannot carry scene objects. Ordinary Spagbol Groups and their float Ins/Outs boundaries are also evaluated; visual Containers do not affect execution.

Spread evaluates indices 1..count in order, with a cap of 1,000 per scope. Active indices retain their runtime identities when count changes. This profile disposes removed indices on shrink; regrowth starts those indices clean. This differs from the proposed suspended-index baseline and bounds retained GPU resources.

Spawn creates on trigger rising through 0.5, with monotonically increasing identities. Release rising through 0.5 lowers gates of instances whose trigger tag exactly matches release; it does not destroy them. Connect a numeric signal to an Instance node's kill input to destroy that instance after its final evaluation. Spawn's optional lifetime input (seconds; zero disables timeout) and limit input (default 100, maximum 1,000) are scene-specific extensions. At capacity new triggers are dropped. Across nested scopes the pipeline allows 4,096 scene entities and 16,384 node evaluations per frame; exceeding either produces an explicit error before applying the scene update. Lifetime advances only on executed ticks.

Conditional Execution defaults closed. While gate < 0.5, it skips contained evaluation, retains state/resources and hides existing entities. Videos pause. Reopening resumes retained entities. A Scene Time signal remains pipeline time; local playheads and spawned-instance ages do not catch up skipped ticks. Removing nodes or scopes disposes their entities. Disabling an entity hides it; deleting it destroys its runtime resources.

Scene entities are keyed by instance path plus node ID. Numeric updates reuse objects and materials; dimension changes rebuild only geometry. Configuration changes rebuild the affected node's resources. Project loading reconstructs runtime state; tab changes do not. Shadowed lights, linear/exponential fog, environment rotation/intensity, PBR/basic/physical materials, text planes and render exposure/tone mapping are scene-renderer concerns; full-frame processing stays in Effects.

## Assets

Nodes accept remote/relative URLs or local file selection. Files are stored separately in IndexedDB and graphs contain `asset:` references, avoiding large embedded media JSON. Object URLs and GPU/media resources are released when runtime entities are removed. Exported projects do not bundle those browser-local files: on another browser/device, select the missing files again or use reachable URLs. Missing and failed assets produce a visible error while the editor continues running. Remote assets must permit browser cross-origin access under the application's existing isolation headers. GLB is the portable local model format; multi-file GLTF models should use URLs with reachable dependencies. Video planes are muted and loop by default. Text uses an installed/loaded CSS font family.

### Painty drawings

Add a **Painty** scene node and choose a `.bmpy` file, or enter a reachable Painty file URL. The v1 reader follows Painty's `docs/bmpy-format.md`, validates the entire document and its memory limits before creating textures, and keeps every layer as a separate double-sided plane. Hidden layers, raw RGBA alpha, layer XY translation/depth/rotation, and document translation/rotation are preserved. Textures use nearest-neighbour sampling and unlit materials so painted colors remain independent of scene lighting.

`size` sets the longest canvas side in scene units (default 2); all imported pixel distances scale by the same factor. The normal position, rotation and scale inputs transform the whole imported drawing. `opacity` multiplies the stored pixel alpha. Painty v1 has no separate layer-opacity field. Imported degrees and downward Y coordinates are converted internally; node rotation inputs still use radians.

The node lists a visibility checkbox for every layer, including layers hidden in the source file. Checkboxes initially follow the file's visibility flags. Changes update the scene immediately without reloading textures, support undo/redo, and are saved with the project per node. Choosing a different file or editing its URL resets these overrides to the new file's defaults.

Painty's **Shadows** checkbox enables both casting and receiving shadows (on by default). Enable Shadows on a Directional, Point or Spot Light to cast shadows onto the layer planes. Shadows darken the painted pixels while unshadowed areas retain their original colors, independent of light intensity. Transparent cutouts do not cast or receive shadows; translucent pixels use the scene's ordinary alpha-tested shadow maps.

Painty's saved perspective is projection metadata, retained on the runtime document group. The scene camera supplies projection for this 3D object. Source pixels are not cropped to Painty's original canvas after transformation. Fully opaque pixels write scene depth in a separate pass, so opaque layers occlude correctly even at intersections. Translucent pixels use the scene renderer's back-to-front object sorting; intersecting translucent planes can show sorting artifacts, unlike Painty's per-pixel fragment sorter. Stored color values composite directly, without sRGB decoding, matching Painty's channel convention. Local files use the same IndexedDB storage, reload and export limitations as other media assets.

`node tests/painty.browser.mjs` (with `SCENE_TEST_URL` set as below) exercises the file picker, alpha/orientation/depth on the GPU, persistence and resource disposal.

## Verification

`npm test` includes the existing shader-project compatibility suite plus scene link arithmetic, group boundaries, instances, conditional visibility, trigger semantics and project roundtrips. `npm run build` checks types and produces the application bundle.

For a real GPU/browser check, start Vite on a free local port, then run:

```sh
SCENE_TEST_URL=http://127.0.0.1:5199 node tests/scene.browser.mjs
```

This uses installed Chrome through Playwright and verifies actual raw/processed pixels, Effects bypass, continuous rendering, persistent object/geometry identities, independent viewports, project saving, removal and context restoration. Its save request is intercepted and does not create a patch file.
