// Loads the libtorrent.wasm + Emscripten JS glue and returns a typed handle
// to the embind Session class. The actual file ships as
// `native/build/libtorrent.js`; the top-level Vite build copies it next to
// the rest of the app, so at runtime the URL is `/libtorrent.js`.
//
// We intentionally keep this a side-effect-free module so callers can decide
// when to instantiate (cheap in the SharedWorker, never on the main thread).

import { installOpfsDisk }     from './disk-opfs'
import { installSocketBridge } from './socket-webvpn'

export type LibtorrentSession = {
  addTorrent (input: string | Uint8Array, storageId: string): string
  removeTorrent (infoHash: string, deleteFiles: boolean): void
  setFilePriority (infoHash: string, fileIndex: number, priority: number): void
  setPieceDeadline (infoHash: string, pieceIndex: number, ms: number): void
  popAlerts (): unknown[]
  sessionStats (): unknown
  torrentStatus (infoHash: string): unknown
  read (infoHash: string, fileIndex: number, offset: number, length: number): Promise<Uint8Array>
  pause (): void
  resume (): void
  saveState (): Uint8Array
  loadState (bytes: Uint8Array): void
}

type Factory = (opts?: { locateFile?: (p: string) => string }) =>
  Promise<{ Session: new () => LibtorrentSession, _malloc: (n: number) => number, _free: (p: number) => void, HEAPU8: Uint8Array }>

let cached: Promise<{ session: LibtorrentSession }> | null = null

export const loadLibtorrent = (): Promise<{ session: LibtorrentSession }> => {
  if (cached) return cached
  cached = (async () => {
    // Bridges must be installed *before* the wasm module starts pumping
    // alerts or trying to open sockets.
    installOpfsDisk()
    installSocketBridge()

    // @ts-expect-error: built artifact ships separately at /libtorrent.js
    const mod = await import(/* @vite-ignore */ '/libtorrent.js') as { default: Factory }
    const inst = await mod.default({
      locateFile: (p) => p.endsWith('.wasm') ? '/libtorrent.wasm' : '/' + p
    })
    // Expose heap helpers globally — disk-opfs.ts uses them when fulfilling
    // synchronous reads from the wasm side.
    ;(globalThis as any)._malloc = inst._malloc
    ;(globalThis as any)._free   = inst._free
    ;(globalThis as any).HEAPU8  = inst.HEAPU8

    return { session: new inst.Session() }
  })()
  return cached
}
