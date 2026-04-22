import { loadLibtorrent, type LibtorrentSession } from './wasm-loader'
import { Torrent }                                from './torrent'
import type { Alert }                             from './alerts'

type AlertHandler = (a: Alert) => void

// One Engine per process (one per SharedWorker). Owns the libtorrent session
// and the torrents map. Pumps alerts on a fixed interval so listeners get
// near-real-time updates without per-call polling.
export class Engine {
  private session!: LibtorrentSession
  private torrents = new Map<string, Torrent>()
  private listeners = new Set<AlertHandler>()
  private pumpHandle: ReturnType<typeof setInterval> | null = null

  static async create (): Promise<Engine> {
    const e = new Engine()
    const { session } = await loadLibtorrent()
    e.session = session
    e.startPump()
    return e
  }

  // Subscribe to alerts. Returns an unsubscribe function.
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

  add (input: string | Uint8Array, opts?: { storageId?: string }): Torrent {
    const tmpId = opts?.storageId ?? Math.random().toString(36).slice(2)
    const infoHash = this.session.addTorrent(input, tmpId)
    if (!infoHash) throw new Error('failed to add torrent')
    const t = new Torrent(this.session, infoHash)
    this.torrents.set(infoHash, t)
    return t
  }

  remove (infoHash: string, deleteFiles = false) {
    const t = this.torrents.get(infoHash)
    if (!t) return
    t.remove(deleteFiles)
    this.torrents.delete(infoHash)
  }

  pause ()  { this.session.pause() }
  resume () { this.session.resume() }

  saveState (): Uint8Array { return this.session.saveState() }
  loadState (b: Uint8Array) { this.session.loadState(b) }

  private startPump () {
    this.pumpHandle = setInterval(() => {
      const alerts = this.session.popAlerts() as Alert[]
      for (const a of alerts) {
        this.applyAlert(a)
        for (const fn of this.listeners) fn(a)
      }
    }, 250)
  }

  private applyAlert (a: Alert) {
    if (a.type === 'metadata_received') {
      const t = this.torrents.get(a.infoHash)
      if (t) t.applyMetadata(a.files)
    } else if (a.type === 'torrent_removed') {
      this.torrents.delete(a.infoHash)
    }
  }

  destroy () {
    if (this.pumpHandle) clearInterval(this.pumpHandle)
    this.pumpHandle = null
    this.session.pause()
  }
}
