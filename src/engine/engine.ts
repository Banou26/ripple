import { loadEngine, type RippleEngine } from './wasm-loader'
import { Torrent }                         from './torrent'
import type { Alert }                      from './alerts'

type AlertHandler = (a: Alert) => void

// One Engine per process (one per SharedWorker). Owns the anacrolix-backed
// torrent.wasm and the local Torrent map. Alerts are pushed from the Go
// side via `__ripple.subscribe`; we fan them out to listeners and update
// local Torrent state as metadata/pieces arrive.
export class Engine {
  private rt!: RippleEngine
  private torrents = new Map<string, Torrent>()
  private listeners = new Set<AlertHandler>()
  private nativeUnsub: (() => void) | null = null

  static async create (): Promise<Engine> {
    const e = new Engine()
    e.rt = await loadEngine()
    e.nativeUnsub = e.rt.subscribe((alertUnknown) => {
      const a = alertUnknown as Alert
      e.applyAlert(a)
      for (const fn of e.listeners) fn(a)
    })
    return e
  }

  subscribe (fn: AlertHandler): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  list (): Torrent[] {
    return [...this.torrents.values()]
  }

  get (infoHash: string): Torrent | undefined {
    return this.torrents.get(infoHash)
  }

  async add (input: string | Uint8Array, opts?: { storageId?: string }): Promise<Torrent> {
    // storageId defaults to the info-hash on the Go side after add returns,
    // but we can't know the hash until add resolves. Use a provisional
    // random ID if caller didn't supply one; the Go side uses this as the
    // OPFS namespace. (Go doesn't reuse info-hash because magnet adds
    // haven't resolved their metadata yet when storage opens.)
    const storageId = opts?.storageId ?? Math.random().toString(36).slice(2)
    const infoHash = await this.rt.addTorrent(input, storageId)
    const t = new Torrent(this.rt, infoHash)
    this.torrents.set(infoHash, t)
    return t
  }

  async remove (infoHash: string, deleteFiles = false): Promise<void> {
    const t = this.torrents.get(infoHash)
    if (!t) return
    await t.remove(deleteFiles)
    this.torrents.delete(infoHash)
  }

  pause ()  { return this.rt.pause() }
  resume () { return this.rt.resume() }

  saveState ()           { return this.rt.saveState() }
  loadState (b: Uint8Array) { return this.rt.loadState(b) }

  private applyAlert (a: Alert) {
    if (a.type === 'metadata_received') {
      const t = this.torrents.get(a.infoHash)
      if (t) t.applyMetadata(a.files)
    } else if (a.type === 'torrent_removed') {
      this.torrents.delete(a.infoHash)
    }
  }

  destroy () {
    if (this.nativeUnsub) this.nativeUnsub()
    this.nativeUnsub = null
  }
}
