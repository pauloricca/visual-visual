# Visual Visual

A web-first prototype for a realtime GPU visual synthesis system.

The app is a browser node editor that exports deterministic patch JSON, generates GLSL, and renders the live shader with WebGL.

## Start

```sh
./start
```

The script runs Docker Compose and opens `http://localhost:5173/`.

- Double-click the black canvas to create a node.
- Type in the node title picker to choose the node type.
- Drag between ports to connect float outputs to float inputs.
- Multiple links can feed one input; selected links expose amplitude and mode controls.
- Drag numeric boxes up/down to change values, or click and type decimals.
- Use `GL` to show/hide the GLSL side panel.
- Use `SV` to save the current patch JSON.
- Use `LD` to load a patch JSON file.
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

## Patch Contract

Patch JSON contains:

- `nodes`: `{ id, type, params, position }`
- `links`: `{ from: { node, port }, to: { node, port }, weight?, mode? }`

All ports are floats. `params` store default values for unconnected inputs and for inputs with only `add`/`multiply` links. Link `mode` defaults to `set`; modes apply in order as averaged `set`, summed `add`, then multiplied `multiply`.
