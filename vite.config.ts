import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// libtorrent.wasm + Emscripten pthreads need cross-origin isolation. The
// dev server and any reverse proxy that fronts production must serve these
// headers on every response (HTML, JS, wasm, workers).
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer (server: any) {
    server.middlewares.use((_req: any, res: any, next: any) => {
      res.setHeader('Cross-Origin-Opener-Policy',   'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      next()
    })
  },
  configurePreviewServer (server: any) {
    server.middlewares.use((_req: any, res: any, next: any) => {
      res.setHeader('Cross-Origin-Opener-Policy',   'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      next()
    })
  }
}

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
  server: {
    headers: {
      'Cross-Origin-Opener-Policy':   'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  plugins: [
    react({ jsxImportSource: '@emotion/react' }),
    crossOriginIsolation
  ]
}))
