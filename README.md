# Visual Visual

A web-first prototype for a realtime GPU visual synthesis system.

The app is a browser node editor that exports deterministic patch JSON, generates GLSL, and renders the live shader with WebGL.

## Start

```sh
./start
```

The script generates a local self-signed HTTPS certificate when `openssl` is available, runs Docker Compose, and opens the editor.
It also prints the standalone viewer URL:

- Editor: `https://localhost:5173/`
- Viewer: `https://localhost:5173/viewer`

Open the viewer on a projector computer and the editor on another client pointed at the same server. Whenever the editor compiles a valid patch, it publishes the latest render bundle to connected viewers. The viewer uses the same WebGL renderer as the editor preview, captures its own local microphone/camera when the shader needs them, and shows only the canvas.

Editor and viewer windows are paired by the `app-id` in the URL. Opening the editor without an `app-id` creates a random 5-character code and appends it to the URL. Open the viewer with the same `app-id`, for example `https://localhost:5173/viewer?app-id=Ab3x9`; if the viewer has no code, it asks for one. This lets multiple editors and viewers share one deployed server without crossing streams.

When started with `./start`, patch save/load uses the local server's `patches/` directory. This applies both on `localhost` and from another device on the LAN: `SV` saves a timestamped JSON version under `patches/<patch name>/`, and `LD` opens the patch/version loader.

To force browser-only patch files while running locally:

```sh
./start --patch-storage=browser
```

Remote/static deployments should use browser-only patch files. In that mode, `SV` downloads a JSON file and `LD` opens the browser file picker.

Browsers allow microphone/camera capture on `localhost`, but usually block it on plain HTTP LAN IPs. `./start` serves HTTPS with a self-signed certificate so projector capture can work at `https://192.168.x.x:5173/viewer`; accept or trust the certificate in the projector browser first. If `openssl` is not available, the script falls back to HTTP and LAN camera/mic capture may be blocked.

- Double-click the black canvas to create a node.
- Type in the node title picker to choose the node type.
- Drag between ports to connect float outputs to float inputs.
- Multiple links can feed one input; selected links expose amplitude and mode controls.
- Drag numeric boxes up/down to change values, or click and type decimals.
- Use `GL` to show/hide the GLSL side panel.
- Use `SV` to save the current patch.
- Use `LD` to load a patch.
- Use `UN` to undo and `RE` to redo graph edits.
- Use `FS` to enter/exit fullscreen mode.
- Use `UI` to hide editor overlays (click to restore).
- The framerate overlay is shown as `120 FPS`.

## Local Development Without Docker

Docker is the default path, but the web app can still run directly with Node:

```sh
npm install
npm run dev
```

Direct local development defaults to local server patch storage. Set `VITE_VISUAL_VISUAL_PATCH_STORAGE=browser` before `npm run dev` to use browser download/upload instead.

## Patch Contract

Patch JSON contains:

- `nodes`: `{ id, type, params, position }`
- `links`: `{ from: { node, port }, to: { node, port }, weight?, mode? }`

All ports are floats. `params` store default values for unconnected inputs and for inputs with only `add`/`multiply` links. Link `mode` defaults to `set`; modes apply in order as averaged `set`, summed `add`, then multiplied `multiply`.
