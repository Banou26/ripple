import type { EngineHandle, Persisted, TorrentClient, TorrentSnapshot } from './client'
import type { Torrent, TorrentState } from './types'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { DEMO_SEEDED_KEY } from './constants'
import { useTorrentClient } from './runtime'
import { magnetInfoHash } from './magnet'
import { cloudRestoreSettled } from './use-cloud-backup'

const magnetParam = (magnet: string, key: string): string | undefined => {
  const m = magnet.match(new RegExp('[?&]' + key + '=([^&]+)'))
  if (!m) return undefined
  try { return decodeURIComponent(m[1]!.replace(/\+/g, ' ')) } catch { return m[1] }
}

const STATE: Record<number, TorrentState> = {
  1: 'queued',
  2: 'downloading',
  3: 'downloading',
  4: 'done',
  5: 'seeding',
  7: 'queued',
}

const fmtEta = (status: TorrentSnapshot['status']): string => {
  if (!status || status.state === 5 || status.state === 4) return '-'
  const remain = status.totalWanted - status.totalDone
  if (remain <= 0) return '-'
  if (status.downloadRate <= 0) return 'queued'
  const s = Math.round(remain / status.downloadRate)
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'
}

export const snapshotToTorrent = (s: TorrentSnapshot): Torrent => {
  const st = s.status
  const infoHash = s.infoHash ?? magnetInfoHash(s.magnet) ?? undefined
  const name = magnetParam(s.magnet, 'dn') ?? s.files?.files[0]?.path.split('/')[0] ?? 'Fetching metadata…'
  const progress = st?.progress ?? 0
  return {
    id: infoHash ?? `${s.engineGeneration}:${s.handle}`,
    ref: s.ref,
    magnet: s.magnet,
    infoHash,
    name,
    size: s.files?.totalSize ?? s.bitfield?.length ?? 0,
    downloaded: st?.totalDone ?? 0,
    progress,
    state: st ? (st.paused ? 'paused' : (STATE[st.state] ?? 'downloading')) : (s.files ? 'queued' : 'downloading'),
    down: s.displayDownloadRate,
    up: st?.uploadRate ?? 0,
    peers: st?.numPeers ?? 0,
    seeds: st?.numSeeds ?? 0,
    eta: fmtEta(st),
    files: s.files?.files.map((f) => ({ name: f.path, size: f.size, progress })),
  }
}

const ghostToTorrent = (e: Persisted): Torrent => ({
  id: 'missing:' + e.infoHash,
  magnet: e.magnet,
  infoHash: e.infoHash,
  name: magnetParam(e.magnet, 'dn') ?? e.infoHash.slice(0, 8),
  size: 0,
  downloaded: 0,
  progress: 0,
  state: 'missing',
  down: 0,
  up: 0,
  peers: 0,
  seeds: 0,
  eta: '-',
})

export type UseTorrents = {
  torrents: Torrent[]
  addMagnet: (magnet: string) => void
  addTorrentFile: (bytes: Uint8Array) => void
  pause: (ref: EngineHandle) => void
  resume: (ref: EngineHandle) => void
  remove: (ref: EngineHandle, deleteFiles?: boolean) => void
  start: (infoHash: string) => void
  removeMissing: (infoHash: string) => void
  storageUnavailable: boolean
  clientRef: { current: TorrentClient | null }
}

const DEMO_TORRENT_URL = new URL('../assets/sintel.torrent', import.meta.url)
const DEMO_MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'
const DEMO_GRACE = 8_000

const addDemo = async (client: TorrentClient, signal: AbortSignal) => {
  try {
    const res = await fetch(DEMO_TORRENT_URL, { signal })
    if (!res.ok) throw new Error(String(res.status))
    await client.addTorrentFile(new Uint8Array(await res.arrayBuffer()))
  } catch (error: any) {
    if (error?.name === 'AbortError' || signal.aborted) throw error
    await client.addMagnet(DEMO_MAGNET)
  }
}

export const useTorrents = (): UseTorrents => {
  const client = useTorrentClient()
  const clientRef = useRef<TorrentClient | null>(client)
  clientRef.current = client
  const [snaps, setSnaps] = useState<TorrentSnapshot[]>([])
  const [list, setList] = useState<Persisted[]>([])
  const [storageUnavailable, setStorageUnavailable] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let checkedDemo = false
    let libraryCount = 0
    const checkDemo = () => {
      if (checkedDemo) return
      checkedDemo = true
      const grace = new Promise<void>((resolve) => { graceTimer = setTimeout(resolve, DEMO_GRACE) })
      void Promise.race([cloudRestoreSettled, grace]).then(async () => {
        if (abort.signal.aborted) return
        const seed = async () => {
          if (abort.signal.aborted || libraryCount !== 0) return
          try {
            if (localStorage.getItem(DEMO_SEEDED_KEY)) return
            await addDemo(client, abort.signal)
            if (!abort.signal.aborted) localStorage.setItem(DEMO_SEEDED_KEY, '1')
          } catch {}
        }
        if (navigator.locks) {
          await navigator.locks.request('ripple:demo-seed', { signal: abort.signal }, seed).catch(() => {})
        } else {
          await seed()
        }
      })
    }
    const offUnavailable = client.onStorageUnavailable(setStorageUnavailable)
    const offList = client.onList((next) => {
      libraryCount = next.length
      setList(next)
      checkDemo()
    })
    const offState = client.onState(setSnaps)
    return () => {
      abort.abort()
      if (graceTimer) clearTimeout(graceTimer)
      offUnavailable()
      offList()
      offState()
    }
  }, [client])

  const torrents = useMemo(() => {
    const live = snaps.map(snapshotToTorrent)
    const liveHashes = new Set(live.map((torrent) => torrent.infoHash).filter(Boolean))
    const ghosts = list
      .filter((entry) => entry.started === false && !liveHashes.has(entry.infoHash))
      .sort((a, b) => a.addedAt - b.addedAt)
      .map(ghostToTorrent)
    return [...live, ...ghosts]
  }, [snaps, list])

  const report = (operation: Promise<unknown>) => { void operation.catch((error) => console.warn('[torrent request]', error)) }
  const addMagnet = useCallback((magnet: string) => {
    const current = clientRef.current
    if (current) report(current.addMagnet(magnet))
  }, [])
  const addTorrentFile = useCallback((bytes: Uint8Array) => {
    const current = clientRef.current
    if (current) report(current.addTorrentFile(bytes))
  }, [])
  const pause = useCallback((ref: EngineHandle) => {
    const current = clientRef.current
    if (current) report(current.pause(ref))
  }, [])
  const resume = useCallback((ref: EngineHandle) => {
    const current = clientRef.current
    if (current) report(current.resume(ref))
  }, [])
  const remove = useCallback((ref: EngineHandle, deleteFiles?: boolean) => {
    const current = clientRef.current
    if (current) report(current.remove(ref, deleteFiles))
  }, [])
  const start = useCallback((infoHash: string) => {
    const current = clientRef.current
    if (current) report(current.start(infoHash))
  }, [])
  const removeMissing = useCallback((infoHash: string) => {
    const current = clientRef.current
    if (current) report(current.removeMissing(infoHash))
  }, [])
  return { torrents, addMagnet, addTorrentFile, pause, resume, remove, start, removeMissing, storageUnavailable, clientRef }
}
