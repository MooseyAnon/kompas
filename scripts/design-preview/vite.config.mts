// Design preview: the real renderer in an ordinary browser, talking to the
// real back end (see backend.ts) over a dev-only HTTP bridge.
//
//   npm run preview:design            sample data
//   PREVIEW_SCENARIO=empty ...        no records (empty states)
//   PREVIEW_SCENARIO=onboarding ...   first-run flow
import path from 'node:path';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

interface PreviewBackend {
  dispatch(raw: unknown): Promise<unknown>;
  close(): Promise<void>;
}

const root = path.resolve(import.meta.dirname, '../..');

function previewBackend(): Plugin {
  let backend: Promise<PreviewBackend> | null = null;

  return {
    name: 'career-design-preview-backend',
    configureServer(server: ViteDevServer) {
      const scenario = process.env.PREVIEW_SCENARIO ?? 'populated';
      backend = server
        .ssrLoadModule('/scripts/design-preview/backend.ts')
        .then(
          (module) =>
            module.createPreviewBackend(scenario) as Promise<PreviewBackend>,
        );

      server.middlewares.use('/__career/request', (req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const envelope = JSON.parse(body);
            const response = await (
              await backend!
            ).dispatch({
              ...envelope,
              requestId: crypto.randomUUID(),
            });
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(response));
          } catch (error) {
            res.statusCode = 500;
            res.end(String((error as Error).stack ?? error));
          }
        });
      });

      server.httpServer?.once('close', () => {
        void backend?.then((b) => b.close());
      });
    },
  };
}

export default defineConfig({
  root,
  configFile: false,
  plugins: [react(), previewBackend()],
  server: { host: '127.0.0.1', port: 5199, open: false },
  ssr: { external: ['better-sqlite3', 'playwright-core'] },
});
