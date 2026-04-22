// Load the Go-built torrent.wasm and wait for it to install its API on
// globalThis.__ripple. Shipped flat at site root: /torrent.wasm and
// /wasm_exec.js. The SharedWorker imports this module.

import { installOpfsDisk }     from './disk-opfs'
import { installSocketBridge } from './socket-webvpn'

// Shape the Go engine installs on globalThis.__ripple. Mirrors native/api.go.
export type RippleEngine = {
  addTorrent      (input: string | Uint8Array, storageId: string): Promise<string>
  removeTorrent   (infoHash: string, deleteFiles: boolean): Promise<void>
  setFilePriority (infoHash: string, fileIndex: number, priority: number): Promise<void>
  setReadahead    (infoHash: string, fileIndex: number, offset: number, bytes: number): Promise<void>
  list            (): Promise<unknown[]>
  status          (infoHash: string): Promise<unknown>
  read            (infoHash: string, fileIndex: number, offset: number, length: number): Promise<Uint8Array>
  subscribe       (cb: (alert: unknown) => void): () => void
  pause           (): Promise<void>
  resume          (): Promise<void>
  saveState       (): Promise<Uint8Array>
  loadState       (bytes: Uint8Array): Promise<void>
}

declare global {
  interface GlobalThis {
    Go: new () => { importObject: WebAssembly.Imports, run (inst: WebAssembly.Instance): Promise<void> }
    __ripple: RippleEngine
    __ripple_ready?: () => void
  }
}

let cached: Promise<RippleEngine> | null = null

export const loadEngine = (): Promise<RippleEngine> => {
  if (cached) return cached
  cached = (async () => {
    // Bridges must be installed before the wasm boots — Go's main() calls
    // into them during engine construction (ListenUDP, etc.).
    installOpfsDisk()
    installSocketBridge()

    // Load Go's runtime glue. wasm_exec.js exposes `globalThis.Go`.
    await loadScript('/wasm_exec.js')

    // The Go runtime calls __ripple_ready after installAPI finishes, which
    // is our signal that the methods are safe to use.
    const ready = new Promise<void>((resolve) => {
      ;(globalThis as any).__ripple_ready = () => resolve()
    })

    const Go: any = (globalThis as any).Go
    const go = new Go()
    const src = await fetch('/torrent.wasm')
    const { instance } = await WebAssembly.instantiateStreaming(src, go.importObject)
    // Run without awaiting — Go's main() parks on select{} forever.
    void go.run(instance)

    await ready
    return (globalThis as any).__ripple as RippleEngine
  })()
  return cached
}

const loadScript = (src: string): Promise<void> => new Promise((resolve, reject) => {
  // In a worker context, importScripts is the only way to load classic JS
  // (wasm_exec.js is not an ES module). The SharedWorker entry runs this
  // module, and importScripts is available on WorkerGlobalScope.
  try {
    ;(self as any).importScripts(src)
    resolve()
  } catch (e) {
    reject(e as Error)
  }
})
