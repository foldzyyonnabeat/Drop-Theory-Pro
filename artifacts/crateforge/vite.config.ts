import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

export default defineConfig(async ({ command, mode }) => {
  const isDesktopMode = mode === 'desktop';
  const rawPort = process.env.PORT ?? (isDesktopMode ? '1420' : undefined);
  if (command === 'serve' && !rawPort) {
    throw new Error('PORT environment variable is required but was not provided.');
  }
  const port = rawPort ? Number(rawPort) : undefined;
  if (rawPort && (port === undefined || !Number.isInteger(port) || port <= 0 || port > 65535)) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }
  const basePath = process.env.BASE_PATH ?? (isDesktopMode || command === 'build' ? '/' : undefined);
  if (!basePath) {
    throw new Error('BASE_PATH environment variable is required but was not provided.');
  }

  return {
  base: basePath,
  plugins: [
    react(),
    tailwindcss({ optimize: false }),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    ...(port === undefined ? {} : { port, strictPort: true }),
    host: '0.0.0.0',
    allowedHosts: true,
    watch: {
      ignored: ['**/src-tauri/target/**'],
    },
    fs: {
      strict: true,
    },
  },
  preview: {
    ...(port === undefined ? {} : { port }),
    host: '0.0.0.0',
    allowedHosts: true,
  },
  };
});
