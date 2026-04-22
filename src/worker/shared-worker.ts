// Entry point for the SharedWorker that owns the libtorrent engine. Every
// tab connects via `new SharedWorker(...)` and talks to it through the RPC
// in `./rpc.ts`.
//
// Why a SharedWorker (not a regular Worker)?
//   - One engine instance across all tabs => no OPFS contention, no need
//     for the BroadcastChannel "active tab" hack.
//   - Tabs can come and go without the engine restarting.
//   - The OPFS sync access handles live here; tabs never touch them.
//
// Fallback: if SharedWorker isn't available (Safari is the usual culprit),
// the client in `./client.ts` falls back to a dedicated Worker per tab. In
// that mode you lose cross-tab sharing but the API is identical.

/// <reference lib="webworker" />

import { Engine } from '../engine'
import type { Req, Res, Envelope } from './rpc'

declare const self: SharedWorkerGlobalScope

let enginePromise: Promise<Engine> | null = null
const ports = new Set<MessagePort>()
const subs = new Map<number, { port: MessagePort, unsubscribe: () => void }>()
let nextSubId = 1

const getEngine = () => enginePromise ??= Engine.create()

const reply = (port: MessagePort, id: number, payload: Res, transfer: Transferable[] = []) => {
  port.postMessage({ id, payload } satisfies Envelope<Res>, transfer)
}

const handle = async (port: MessagePort, env: Envelope<Req>) => {
  const { id, payload: req } = env
  try {
    const engine = await getEngine()

    switch (req.kind) {
      case 'list': {
        const torrents = engine.list().map(t => ({
          infoHash: t.infoHash,
          files: t.files,
          status: t.status()
        }))
        reply(port, id, { kind: 'list', torrents })
        return
      }
      case 'add': {
        const t = engine.add(req.input, { storageId: req.storageId })
        reply(port, id, { kind: 'add', infoHash: t.infoHash })
        return
      }
      case 'remove':
        engine.remove(req.infoHash, req.deleteFiles ?? false)
        reply(port, id, { kind: 'remove' })
        return
      case 'status': {
        const t = engine.get(req.infoHash)
        if (!t) throw new Error(`unknown torrent ${req.infoHash}`)
        reply(port, id, { kind: 'status', status: t.status() })
        return
      }
      case 'select': {
        const t = engine.get(req.infoHash)
        if (!t) throw new Error(`unknown torrent ${req.infoHash}`)
        t.selectFile(req.fileIndex)
        reply(port, id, { kind: 'select' })
        return
      }
      case 'deadline': {
        const t = engine.get(req.infoHash)
        if (!t) throw new Error(`unknown torrent ${req.infoHash}`)
        t.setPieceDeadline(req.piece, req.ms)
        reply(port, id, { kind: 'deadline' })
        return
      }
      case 'read': {
        const t = engine.get(req.infoHash)
        if (!t) throw new Error(`unknown torrent ${req.infoHash}`)
        const u8 = await t.read(req.fileIndex, req.offset, req.length)
        // Always copy into a fresh ArrayBuffer (libtorrent's pthreads build
        // makes the underlying buffer SharedArrayBuffer, which can't be
        // transferred). Keeps the wire type concrete.
        const buf = new ArrayBuffer(u8.byteLength)
        new Uint8Array(buf).set(u8)
        reply(port, id, { kind: 'read', bytes: buf }, [buf])
        return
      }
      case 'subscribe': {
        const subId = nextSubId++
        const unsubscribe = engine.subscribe(alert => {
          reply(port, id, { kind: 'event', subId, alert })
        })
        subs.set(subId, { port, unsubscribe })
        reply(port, id, { kind: 'subscribe', subId })
        return
      }
      case 'cancel': {
        const s = subs.get(req.subId)
        if (s) { s.unsubscribe(); subs.delete(req.subId) }
        reply(port, id, { kind: 'cancel' })
        return
      }
    }
  } catch (e) {
    reply(port, id, { kind: 'error', message: (e as Error).message })
  }
}

self.onconnect = (ev: MessageEvent) => {
  const port = (ev as any).ports[0] as MessagePort
  ports.add(port)
  port.onmessage = (m) => handle(port, m.data as Envelope<Req>)
  port.start()
}
