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
  },
  worker: {
    format: 'es'
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(env.mode)
  },
  plugins: [
    react({ jsxImportSource: '@emotion/react' })
  ]
}))
