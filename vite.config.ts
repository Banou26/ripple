import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Single-threaded build: no pthreads, no SharedArrayBuffer, so no
// Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy needed. The
// libtorrent.wasm module runs on a single thread and uses Asyncify for
// every blocking syscall (socket recv, disk I/O, getaddrinfo).

export default defineConfig((env) => ({
  build: {
    outDir: 'build',
    target: 'esnext',
    emptyOutDir: false,
    lib: {
      entry: ['src/index.tsx'],
      formats: ['es']
    },
    rollupOptions: {
      // libtorrent.js is built separately by `npm run build-native` and
      // copied next to the app at /libtorrent.js. Keep it external so
      // Rollup doesn't try to resolve it at bundle time.
      external: [/^\/libtorrent\.js$/]
    }
  },
  worker: {
    format: 'es',
    rollupOptions: {
      external: [/^\/libtorrent\.js$/]
    }
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(env.mode)
  },
  optimizeDeps: {
    // The libtorrent.wasm module is loaded dynamically from /libtorrent.js
    // at runtime; don't try to pre-bundle it.
    exclude: ['/libtorrent.js']
  },
  plugins: [
    react({ jsxImportSource: '@emotion/react' })
  ]
}))
