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
- Multiple links can feed one input; their values are averaged.
- Drag numeric boxes up/down to change values, or click and type decimals.
- Use the right panel to copy/import JSON or inspect GLSL.

## Local Development Without Docker

Docker is the default path, but the web app can still run directly with Node:

```sh
npm install
npm run dev
```

## Patch Contract

Patch JSON contains:

- `nodes`: `{ id, type, params, position }`
- `links`: `{ from: { node, port }, to: { node, port } }`

All ports are floats. `params` store default values for unconnected inputs.
