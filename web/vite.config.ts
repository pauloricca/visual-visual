import { existsSync, readFileSync } from 'node:fs';
import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), renderSyncPlugin()],
  server: {
    https: viteHttpsConfig(),
  },
  preview: {
    https: viteHttpsConfig(),
  },
});

function viteHttpsConfig() {
  const keyPath = process.env.VISUAL_VISUAL_HTTPS_KEY;
  const certPath = process.env.VISUAL_VISUAL_HTTPS_CERT;
  if (!keyPath || !certPath || !existsSync(keyPath) || !existsSync(certPath)) return undefined;

  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  };
}

function renderSyncPlugin(): Plugin {
  let latestBundle: string | null = null;
  const clients = new Set<Connect.ServerResponse>();

  const sendBundle = (response: Connect.ServerResponse, bundle: string) => {
    response.write(`event: render-bundle\ndata: ${bundle}\n\n`);
  };

  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const path = request.url?.split('?')[0] ?? '';

    if (path === '/api/render-bundle' && request.method === 'GET') {
      response.statusCode = latestBundle ? 200 : 204;
      response.setHeader('Cache-Control', 'no-store');
      if (latestBundle) {
        response.setHeader('Content-Type', 'application/json');
        response.end(latestBundle);
      } else {
        response.end();
      }
      return;
    }

    if (path === '/api/render-bundle' && request.method === 'POST') {
      readRequestBody(request).then((body) => {
        latestBundle = body;
        response.statusCode = 204;
        response.end();
        for (const client of clients) {
          sendBundle(client, body);
        }
      }).catch((error: unknown) => {
        response.statusCode = 400;
        response.setHeader('Content-Type', 'text/plain');
        response.end(error instanceof Error ? error.message : String(error));
      });
      return;
    }

    if (path === '/api/render-events' && request.method === 'GET') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Connection', 'keep-alive');
      response.write('retry: 1000\n\n');
      clients.add(response);

      if (latestBundle) {
        sendBundle(response, latestBundle);
      }

      request.on('close', () => {
        clients.delete(response);
      });
      return;
    }

    next();
  };

  return {
    name: 'visual-visual-render-sync',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

function readRequestBody(request: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}
