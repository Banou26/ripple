// libtorrent-wasm Session in a Web Worker over @fkn/lib/{net,dgram}; owns persistence (list + fast-resume in IndexedDB, data in OPFS)

import './node-shims'

import * as net from '@fkn/lib/net'
import * as dgram from '@fkn/lib/dgram'
import { get, set, del, update } from 'idb-keyval'
import { createSession } from 'libtorrent-wasm'
import type { Session } from 'libtorrent-wasm'
import { OPFSStorage } from 'libtorrent-wasm/opfs'

import type {
  EngineBootstrapMessage,
  EngineRequest,
  EngineResponse,
  Persisted,
  TorrentEventTopic,
  TorrentOperation,
  TorrentSnapshot,
} from './protocol'

import { magnetInfoHash } from './magnet'
import { ENGINE_LOCK_NAME } from './protocol'

export type { Persisted, TorrentSnapshot } from './protocol'

const LIST_KEY = 'ripple:torrents'
const resumeKey = (ih: string) => 'ripple:resume:' + ih
const torrentKey = (ih: string) => 'ripple:torrent:' + ih
let session: Session | null = null
const handles: number[] = []
const magnetByHandle = new Map<number, string>()
const infoHashByHandle = new Map<number, string>()
const savePathByHandle = new Map<number, string>()
const resumeSaved = new Set<number>()
const backgroundTasks = new Set<Promise<unknown>>()
let stateTimer: number | undefined
let resumeTimer: number | undefined
let controlPort: MessagePort | undefined
let acceptingRequests = false
let shuttingDown = false
let releaseEngineLock: (() => void) | undefined
let lockAbort: AbortController | undefined
let mutationQueue = Promise.resolve()

const postEvent = (topic: TorrentEventTopic, payload?: any, transfer?: Transferable[]) =>
  controlPort?.postMessage({ kind: 'event', topic, payload }, transfer ?? [])

const respond = (response: EngineResponse, transfer?: Transferable[]) =>
  controlPort?.postMessage(response, transfer ?? [])

const trackTask = <T>(task: Promise<T>): Promise<T> => {
  backgroundTasks.add(task)
  void task.finally(() => backgroundTasks.delete(task)).catch(() => {})
  return task
}

const snapshot = (): TorrentSnapshot[] =>
  handles.map((h) => {
    const bf = session!.bitfield(h)
    return {
      handle: h,
      infoHash: infoHashByHandle.get(h) ?? null,
      magnet: magnetByHandle.get(h) ?? '',
      files: session!.files(h),
      status: session!.status(h),
      bitfield: bf ? { numPieces: bf.numPieces, pieceLength: bf.pieceLength, length: bf.length, pieces: bf.pieces } : null,
    }
  })

// ---- persistence ----------------------------------------------------------
// update() keeps each read-modify-write in one IDB transaction, so interleaved async handlers can't drop entries
const loadList = async (): Promise<Persisted[]> => (await get(LIST_KEY)) ?? []
const upsertList = async (entry: Persisted) => {
  let list: Persisted[] = []
  await update<Persisted[]>(LIST_KEY, (prev) => {
    list = prev ?? []
    const i = list.findIndex((e) => e.infoHash === entry.infoHash)
    if (i >= 0) list[i] = entry; else list.push(entry)
    return list
  })
  postEvent('list', list)
}
const removeFromList = async (ih: string) => {
  let list: Persisted[] = []
  await update<Persisted[]>(LIST_KEY, (prev) => (list = (prev ?? []).filter((e) => e.infoHash !== ih)))
  await del(resumeKey(ih)).catch(() => {})
  await del(torrentKey(ih)).catch(() => {})
  postEvent('list', list)
}

const track = (h: number, magnet: string, ih: string | null, savePath: string) => {
  if (!handles.includes(h)) handles.push(h)
  magnetByHandle.set(h, magnet)
  if (ih) infoHashByHandle.set(h, ih)
  savePathByHandle.set(h, savePath)
}
const untrack = (h: number) => {
  const i = handles.indexOf(h); if (i >= 0) handles.splice(i, 1)
  magnetByHandle.delete(h); infoHashByHandle.delete(h); savePathByHandle.delete(h); resumeSaved.delete(h)
  for (const k of lastReadOffset.keys()) if (k.startsWith(h + ':')) lastReadOffset.delete(k)
}

const resolveHandle = (payload: any): number => {
  const handle = Number(payload?.handle)
  if (!Number.isInteger(handle) || !handles.includes(handle)) throw new Error('STALE_TORRENT_REF')
  if (payload?.infoHash && infoHashByHandle.get(handle) !== payload.infoHash) throw new Error('STALE_TORRENT_REF')
  return handle
}

const persistResume = async (h: number, timeoutMs?: number) => {
  const ih = infoHashByHandle.get(h)
  if (!ih || !session) return
  try { await set(resumeKey(ih), await session.saveResumeData(h, timeoutMs)) } catch {}
}

const filePieceRange = (h: number, fileIndex: number) => {
  const files = session?.files(h)
  const file = files?.files[fileIndex]
  if (!files || !file || file.size <= 0) return null
  const p0 = Math.floor(file.offset / files.pieceLength)
  const p1 = Math.floor((file.offset + file.size - 1) / files.pieceLength)
  return { file, pieceLength: files.pieceLength, p0, p1 }
}

const prioritizeFile = (h: number, fileIndex: number, fromOffset = 0) => {
  const r = filePieceRange(h, fileIndex)
  if (!session || !r) return
  const pAt = Math.floor((r.file.offset + Math.min(fromOffset, r.file.size - 1)) / r.pieceLength)
  const prios = new Uint8Array(r.p1 + 1).fill(4)
  for (let p = r.p0; p <= r.p1; p++) prios[p] = p >= pAt ? 7 : 1
  session.prioritizePieces(h, prios)
}

const hasBytes = (h: number, fileIndex: number, offset: number, len: number) => {
  const files = session?.files(h)
  const file = files?.files[fileIndex]
  const bf = session?.bitfield(h)
  if (!files || !file || !bf) return false
  const p0 = Math.floor((file.offset + offset) / files.pieceLength)
  const p1 = Math.floor((file.offset + Math.min(offset + len, file.size) - 1) / files.pieceLength)
  for (let p = p0; p <= p1; p++) if (!((bf.pieces[p >> 3] ?? 0) & (0x80 >> (p & 7)))) return false
  return true
}

// A read far from the previous one is a seek: re-anchor piece priorities so
// sequential filling continues from the playhead instead of the file start.
const ANCHOR_JUMP = 16_777_216
const lastReadOffset = new Map<string, number>()
const anchorSequential = (h: number, fileIndex: number, offset: number) => {
  const key = h + ':' + fileIndex
  const last = lastReadOffset.get(key)
  lastReadOffset.set(key, offset)
  if (last !== undefined && Math.abs(offset - last) < ANCHOR_JUMP) return
  prioritizeFile(h, fileIndex, offset)
}

// Does OPFS still hold any downloaded data under these save paths? Lets a restore
// tell a normal resume from "the list survived but the files were cleared/evicted"
// (e.g. the user cleared site storage). On any OPFS error assume data is present, so
// a transient read failure never wrongly demotes torrents to "Files missing".
const opfsHasData = async (savePaths: string[]): Promise<boolean> => {
  try {
    const root = await navigator.storage.getDirectory()
    for (const sp of new Set(savePaths)) {
      let dir: FileSystemDirectoryHandle | null = root
      for (const seg of sp.split('/').filter(Boolean)) {
        dir = dir ? await dir.getDirectoryHandle(seg).catch(() => null) : null
      }
      if (!dir) continue
      for await (const _ of (dir as any).keys()) return true
    }
    return false
  } catch { return true }
}

// OPFS with a SyncAccessHandle is the only storage backend. Some contexts refuse
// it (Firefox private windows throw SecurityError from getDirectory(); others
// reject createSyncAccessHandle), which otherwise surfaces as a silent WASI EIO
// that pauses every torrent. Probe up front so the UI can say Ripple needs a
// normal (non-incognito) window instead of failing silently.
const opfsAvailable = async (): Promise<boolean> => {
  let root: FileSystemDirectoryHandle | undefined
  let probe: string | undefined
  try {
    root = await navigator.storage.getDirectory()
    probe = `.ripple-probe-${crypto.randomUUID()}`
    const file = await root.getFileHandle(probe, { create: true })
    const access = await (file as any).createSyncAccessHandle() as FileSystemSyncAccessHandle
    access.close()
    await root.removeEntry(probe).catch(() => {})
    return true
  } catch {
    if (root && probe) await root.removeEntry(probe).catch(() => {})
    return false
  }
}

const init = async () => {
  const origErr = console.error.bind(console)
  console.error = (...args: any[]) => { origErr(...args); try { postEvent('worker-error', args.map(String)) } catch {} }

  if (!(await opfsAvailable())) {
    postEvent('storage', { available: false })
    postEvent('phase', 'storage-unavailable')
    return
  }
  postEvent('storage', { available: true })

  session = await createSession({ net, dgram, storage: new OPFSStorage(), utpReceiveBufferBytes: 4_194_304 })
  for (let i = 0; i < 30; i++) session.tick()

  // Restore the persisted list. With a saved fast-resume blob, add via resume so
  // libtorrent trusts the on-disk pieces (no recheck / no network re-download).
  try {
    const list = await loadList()
    // If the list survived but OPFS holds no data, the files were cleared/evicted -
    // demote torrents that had real data (a resume blob) to "Files missing" rather
    // than silently re-downloading everything from scratch.
    const cleared = !(await opfsHasData(list.map((e) => e.savePath || '/dl')))
    let changed = false
    for (const e of list) {
      // Synced-but-not-started torrents stay out of the session (rendered as
      // "Files missing" ghosts) until the user downloads them.
      if (e.started === false) continue
      const savePath = e.savePath || '/dl'
      const resume = (await get(resumeKey(e.infoHash))) as Uint8Array | undefined
      const bytes = (await get(torrentKey(e.infoHash))) as Uint8Array | undefined
      if (cleared && resume && resume.byteLength) {
        // The resume blob describes OPFS pieces that are gone; drop it so a reload
        // mid-redownload can't trust a stale have-set against files that aren't there.
        await del(resumeKey(e.infoHash)).catch(() => {})
        e.started = false; changed = true; continue
      }
      const h = resume && resume.byteLength
        ? session.addTorrentWithResume(resume, savePath)
        : bytes && bytes.byteLength
          ? session.addTorrentFile(bytes, savePath)
          : session.addMagnet(e.magnet, savePath)
      track(h, e.magnet, e.infoHash, savePath)
    }
    if (changed) await set(LIST_KEY, list)
  } catch (err) { console.error('[worker] restore failed', err) }

  postEvent('list', await loadList())
  acceptingRequests = true
  postEvent('phase', 'ready')

  stateTimer = self.setInterval(() => {
    if (!session) return
    session.popAlerts()
    for (const h of handles) session.postStatus(h)
    postEvent('state', snapshot())
    // Snapshot resume data the first time a torrent completes, so a reload right
    // after finishing still resumes from OPFS rather than re-downloading.
    for (const h of handles) {
      const st = session.status(h)
      if (st && (st.state === 4 || st.state === 5) && !resumeSaved.has(h)) {
        resumeSaved.add(h); void trackTask(persistResume(h))
      }
    }
  }, 500)

  // Periodic resume snapshot for in-progress torrents.
  resumeTimer = self.setInterval(() => {
    if (!session) return
    for (const h of handles) {
      const st = session.status(h)
      if (st && st.state === 3) void trackTask(persistResume(h))
    }
  }, 15000)
}

const clearTimers = () => {
  if (stateTimer !== undefined) self.clearInterval(stateTimer)
  if (resumeTimer !== undefined) self.clearInterval(resumeTimer)
  stateTimer = undefined
  resumeTimer = undefined
}

const persistAll = async () => {
  if (!session) return
  await Promise.all(handles.map((handle) => persistResume(handle, 3_000)))
}

const withAlertPump = async (work: () => Promise<void>) => {
  const timer = self.setInterval(() => { session?.popAlerts() }, 50)
  try { await work() } finally { self.clearInterval(timer) }
}

const checkpoint = async () => {
  const queued = mutationQueue
  await withAlertPump(async () => {
    await queued.catch(() => {})
    await Promise.allSettled(backgroundTasks)
    await persistAll()
  })
}

const checkpointAndShutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  acceptingRequests = false
  clearTimers()
  lockAbort?.abort()
  await withAlertPump(async () => {
    await mutationQueue.catch(() => {})
    await Promise.allSettled(backgroundTasks)
    await persistAll()
  })
  try { session?.destroy() } finally {
    session = null
    releaseEngineLock?.()
    releaseEngineLock = undefined
  }
}

const handleOperation = async (op: TorrentOperation, payload: any): Promise<any> => {
  if (op === 'checkpoint') return checkpoint()
  if (op === 'checkpoint-and-shutdown') return checkpointAndShutdown()
  if (!session) throw new Error('worker not initialized')
  const p = payload ?? {}

  if (op === 'add-magnet') {
    const savePath = p.savePath || '/dl'
    const ih = magnetInfoHash(p.magnet)
    const existing = ih ? handles.find((h) => infoHashByHandle.get(h) === ih) : undefined
    if (existing !== undefined) return { handle: existing, magnet: magnetByHandle.get(existing) || p.magnet }
    const handle = session.addMagnet(p.magnet, savePath)
    track(handle, p.magnet, ih, savePath)
    if (ih) await upsertList({ infoHash: ih, magnet: p.magnet, savePath, addedAt: Date.now() })
    return { handle, magnet: p.magnet }
  }

  if (op === 'add-torrent-file') {
    const savePath = p.savePath || '/dl'
    const bytes = p.bytes as Uint8Array
    const handle = session.addTorrentFile(bytes, savePath)
    if (!Number.isSafeInteger(handle) || handle < 0 || handle > 0x7fffffff) throw new Error('invalid torrent file')
    track(handle, '', null, savePath)
    try {
      let infoHash: string | null = null
      for (let i = 0; i < 40 && !(infoHash = session.infohash(handle)); i++) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (!infoHash) throw new Error('torrent metadata unavailable')
      const magnet = 'magnet:?xt=urn:btih:' + infoHash
      track(handle, magnet, infoHash, savePath)
      await set(torrentKey(infoHash), bytes)
      await upsertList({ infoHash, magnet, savePath, addedAt: Date.now() })
      return { handle, magnet, infoHash }
    } catch (error) {
      try { session.removeTorrent(handle, false) } catch {}
      untrack(handle)
      throw error
    }
  }

  if (op === 'read') {
    const handle = resolveHandle(p)
    if (p.prioritize !== false) anchorSequential(handle, p.fileIndex, p.offset)
    else if (!hasBytes(handle, p.fileIndex, p.offset, p.len)) throw new Error('not downloaded')
    return session.read(handle, p.fileIndex, p.offset, p.len)
  }

  if (op === 'remove') {
    const handle = resolveHandle(p)
    const ih = infoHashByHandle.get(handle)
    session.removeTorrent(handle, !!p.deleteFiles)
    untrack(handle)
    if (ih) await removeFromList(ih)
    return
  }

  if (op === 'import-list') {
    const incoming: Persisted[] = Array.isArray(p.list) ? p.list : []
    let list: Persisted[] = []
    let changed = false
    await update<Persisted[]>(LIST_KEY, (prev) => {
      list = prev ?? []
      const have = new Set(list.map((entry) => entry.infoHash))
      for (const entry of incoming) {
        if (!entry || typeof entry.infoHash !== 'string' || !entry.magnet || have.has(entry.infoHash)) continue
        list.push({ infoHash: entry.infoHash, magnet: entry.magnet, savePath: entry.savePath || '/dl', addedAt: entry.addedAt || Date.now(), started: false })
        have.add(entry.infoHash)
        changed = true
      }
      return list
    })
    if (changed) postEvent('list', list)
    return
  }

  if (op === 'start') {
    const entry = (await loadList()).find((item) => item.infoHash === p.infoHash)
    if (!entry) return
    const savePath = entry.savePath || '/dl'
    const bytes = (await get(torrentKey(entry.infoHash))) as Uint8Array | undefined
    const handle = bytes?.byteLength
      ? session.addTorrentFile(bytes, savePath)
      : session.addMagnet(entry.magnet, savePath)
    track(handle, entry.magnet, entry.infoHash, savePath)
    postEvent('state', snapshot())
    await upsertList({ ...entry, started: true })
    return
  }

  if (op === 'remove-missing') {
    if (typeof p.infoHash !== 'string') return
    const handle = handles.find((item) => infoHashByHandle.get(item) === p.infoHash)
    if (handle !== undefined) { session.removeTorrent(handle, true); untrack(handle) }
    await removeFromList(p.infoHash)
    return
  }

  if (op === 'clear-list') {
    while (handles.length > 0) {
      const handle = handles[0]!
      session.removeTorrent(handle, false)
      untrack(handle)
    }
    let dropped: Persisted[] = []
    await update<Persisted[]>(LIST_KEY, (prev) => { dropped = prev ?? []; return [] })
    for (const entry of dropped) {
      await del(resumeKey(entry.infoHash)).catch(() => {})
      await del(torrentKey(entry.infoHash)).catch(() => {})
    }
    postEvent('list', [])
    return
  }

  if (op === 'pause') {
    const handle = resolveHandle(p)
    session.pauseTorrent(handle)
    void trackTask(persistResume(handle))
    return
  }
  if (op === 'resume') { session.resumeTorrent(resolveHandle(p)); return }
  if (op === 'prioritize-file') {
    prioritizeFile(resolveHandle(p), p.fileIndex, p.fromOffset ?? 0)
    return
  }
  if (op === 'prioritize-range') {
    session.prioritizeRange(resolveHandle(p), p.fileIndex, p.offset, p.len)
    return
  }

  if (op === 'acquire-playback') {
    const handle = resolveHandle(p)
    session.setSequential(handle, true)
    prioritizeFile(handle, p.fileIndex, p.fromOffset ?? 0)
    return
  }

  if (op === 'release-playback') {
    const handle = resolveHandle(p)
    session.setSequential(handle, false)
    session.clearPieceDeadlines(handle)
    const files = session.files(handle)
    if (files) session.prioritizePieces(handle, new Uint8Array(files.numPieces).fill(4))
    return
  }

}

const dispatchRequest = (request: EngineRequest) => {
  if (!acceptingRequests && request.op !== 'checkpoint' && request.op !== 'checkpoint-and-shutdown') {
    respond({ kind: 'response', id: request.id, ok: false, error: shuttingDown ? 'worker shutting down' : 'worker not ready' })
    return
  }

  const run = () => handleOperation(request.op, request.payload)
  const operation = request.op === 'read' || request.op === 'checkpoint' || request.op === 'checkpoint-and-shutdown'
    ? run()
    : mutationQueue.then(run, run)
  if (request.op !== 'read' && request.op !== 'checkpoint' && request.op !== 'checkpoint-and-shutdown') {
    mutationQueue = operation.then(() => {}, () => {})
  }

  void operation.then(
    (value) => {
      if (value instanceof Uint8Array) {
        respond({ kind: 'response', id: request.id, ok: true, value }, [value.buffer])
      } else {
        respond({ kind: 'response', id: request.id, ok: true, value })
      }
    },
    (error) => respond({ kind: 'response', id: request.id, ok: false, error: String(error?.stack ?? error) }),
  )
}

const startWithEngineLock = async () => {
  const locks = (self.navigator as Navigator).locks
  if (!locks) {
    postEvent('phase', 'starting')
    try { await init() } catch (error: any) {
      postEvent('worker-error', [String(error?.stack ?? error)])
      postEvent('phase', 'fatal')
    }
    return
  }

  postEvent('phase', 'waiting-for-lock')
  lockAbort = new AbortController()
  try {
    await locks.request(ENGINE_LOCK_NAME, { signal: lockAbort.signal }, async () => {
      if (shuttingDown) return
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      releaseEngineLock = release
      postEvent('phase', 'starting')
      try {
        await init()
      } catch (error: any) {
        postEvent('worker-error', [String(error?.stack ?? error)])
        postEvent('phase', 'fatal')
      }
      if (!session) release()
      await held
    })
  } catch (error: any) {
    if (!shuttingDown && error?.name !== 'AbortError') {
      postEvent('worker-error', [String(error?.stack ?? error)])
      postEvent('phase', 'fatal')
    }
  }
}

const attachEngine = (message: EngineBootstrapMessage) => {
  if (controlPort) {
    message.port.close()
    return
  }
  controlPort = message.port
  controlPort.addEventListener('message', (event: MessageEvent<EngineRequest>) => {
    const request = event.data
    if (!request || request.kind !== 'request' || typeof request.id !== 'number' || typeof request.op !== 'string') return
    dispatchRequest(request)
  })
  controlPort.start()
  void startWithEngineLock()
}

self.addEventListener('message', (event: MessageEvent<EngineBootstrapMessage>) => {
  const message = event.data
  if (message?.kind === 'attach-engine' && message.port instanceof MessagePort) attachEngine(message)
})
