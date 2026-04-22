// Tab-side client. Wraps the SharedWorker port behind a Promise/AsyncIter
// surface so React code can use the engine without ever touching MessagePort.
//
// One EngineClient per tab. Internally it uses a single SharedWorker shared
// across all tabs; the worker owns the actual libtorrent.

import type { Req, Res, Envelope, ListItem } from './rpc'
import type { Alert }                        from '../engine/alerts'
import type { TorrentSnapshot }              from '../engine/torrent'

type Pending = { resolve: (v: Res) => void, reject: (e: Error) => void }

export class EngineClient {
  private port: MessagePort
  private nextId = 1
  private pending = new Map<number, Pending>()
  private subListeners = new Map<number, Set<(a: Alert) => void>>()
  private subToReqId = new Map<number, number>()

  constructor () {
    // SharedWorker entry compiled by Vite. The query param triggers Vite's
    // worker plugin and produces a hashed asset URL.
    const w = new SharedWorker(
      new URL('./shared-worker.ts', import.meta.url),
      { type: 'module', name: 'ripple-engine' }
    )
    this.port = w.port
    this.port.onmessage = (m) => this.dispatch(m.data as Envelope<Res>)
    this.port.start()
  }

  private dispatch (env: Envelope<Res>) {
    const { id, payload } = env
    if (payload.kind === 'event') {
      const set = this.subListeners.get(payload.subId)
      if (set) for (const fn of set) fn(payload.alert)
      return
    }
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    if (payload.kind === 'error') p.reject(new Error(payload.message))
    else p.resolve(payload)
  }

  private send (req: Req, transfer: Transferable[] = []): Promise<Res> {
    const id = this.nextId++
    return new Promise<Res>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.port.postMessage({ id, payload: req } satisfies Envelope<Req>, transfer)
    })
  }

  // -------- public API -----------------------------------------------------

  async list (): Promise<ListItem[]> {
    const r = await this.send({ kind: 'list' })
    if (r.kind !== 'list') throw new Error('protocol error')
    return r.torrents
  }

  async add (input: string | Uint8Array, opts?: { storageId?: string }): Promise<string> {
    const r = await this.send({ kind: 'add', input, storageId: opts?.storageId })
    if (r.kind !== 'add') throw new Error('protocol error')
    return r.infoHash
  }

  async remove (infoHash: string, deleteFiles = false): Promise<void> {
    await this.send({ kind: 'remove', infoHash, deleteFiles })
  }

  async status (infoHash: string): Promise<TorrentSnapshot> {
    const r = await this.send({ kind: 'status', infoHash })
    if (r.kind !== 'status') throw new Error('protocol error')
    return r.status
  }

  async select (infoHash: string, fileIndex: number): Promise<void> {
    await this.send({ kind: 'select', infoHash, fileIndex })
  }

  async readahead (infoHash: string, fileIndex: number, offset: number, bytes: number): Promise<void> {
    await this.send({ kind: 'readahead', infoHash, fileIndex, offset, bytes })
  }

  async read (infoHash: string, fileIndex: number, offset: number, length: number): Promise<Uint8Array> {
    const r = await this.send({ kind: 'read', infoHash, fileIndex, offset, length })
    if (r.kind !== 'read') throw new Error('protocol error')
    return new Uint8Array(r.bytes)
  }

  // ReadableStream over a file. Mirrors Torrent.stream() but goes through
  // the worker boundary; suitable for piping into the media player.
  stream (infoHash: string, fileIndex: number, opts: { start?: number, end: number, chunkSize?: number }): ReadableStream<Uint8Array> {
    const start = opts.start ?? 0
    const end   = opts.end
    const chunk = opts.chunkSize ?? 256 * 1024
    let off = start
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (off >= end) { controller.close(); return }
        const len = Math.min(chunk, end - off)
        const data = await this.read(infoHash, fileIndex, off, len)
        controller.enqueue(data)
        off += data.byteLength
      }
    })
  }

  // Subscribe to alert stream. Returns an unsubscribe handle.
  async subscribe (handler: (a: Alert) => void): Promise<() => Promise<void>> {
    const r = await this.send({ kind: 'subscribe' })
    if (r.kind !== 'subscribe') throw new Error('protocol error')
    const subId = r.subId
    let set = this.subListeners.get(subId)
    if (!set) { set = new Set(); this.subListeners.set(subId, set) }
    set.add(handler)
    return async () => {
      const s = this.subListeners.get(subId)
      if (s) { s.delete(handler); if (s.size === 0) this.subListeners.delete(subId) }
      await this.send({ kind: 'cancel', subId })
    }
  }
}

let singleton: EngineClient | null = null
export const getEngineClient = () => singleton ??= new EngineClient()
