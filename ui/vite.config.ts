import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    wasm(),
    // vite-plugin-top-level-await removed: target is already 'esnext', which
    // has native top-level await in both the browser and ES module workers.
    // The plugin uses CJS require() internally which breaks in Bun's ESM env.
  ],

  resolve: {
    alias: {
      // Import pre-compiled JS — tsc (not esbuild) with emitDecoratorMetadata:true
      // is required for o1js @method/@state decorators to work at runtime.
      // Rebuild after contract changes: cd contracts && bun run build
      'blind-auction-contracts': path.resolve(__dirname, '../contracts/dist/index.js'),
    },
  },

  // o1js must not be pre-bundled: it loads WASM dynamically and has
  // top-level await that breaks Vite's dep optimiser.
  optimizeDeps: {
    exclude: ['o1js'],
  },

  // Workers must be ES modules so they can import o1js and use WASM.
  worker: {
    format: 'es',
    plugins: () => [wasm()],
  },

  build: {
    target: 'esnext',
  },

  server: {
    // SharedArrayBuffer (required by o1js WASM threads) needs these headers.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },

  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
