import type { EngineHandle, TorrentSnapshot } from './client'

import { useEffect, useRef, useState } from 'react'

import { magnetInfoHash } from './magnet'
import { useTorrentClient } from './runtime'

export type PlayerTorrent = {
  snapshot: TorrentSnapshot | null
  engineGeneration: number
  playbackRevoked: boolean
  read: (offset: number, size: number) => Promise<ArrayBuffer>
  readQuiet: (offset: number, size: number) => Promise<ArrayBuffer>
  prioritizeFrom: (offset: number) => void
}

export const usePlayerTorrent = (magnet: string | undefined, fileIndex: number): PlayerTorrent => {
  const client = useTorrentClient()
  const refRef = useRef<EngineHandle | null>(null)
  const [snapshot, setSnapshot] = useState<TorrentSnapshot | null>(null)
  const [playbackRevoked, setPlaybackRevoked] = useState(false)

  useEffect(() => {
    const infoHash = magnet ? magnetInfoHash(magnet) : null
    refRef.current = null
    setSnapshot(null)
    setPlaybackRevoked(false)
    if (!magnet || !infoHash) return

    let disposed = false
    let leaseAcquired = false
    let leasePending = false
    let leaseRef: EngineHandle | undefined
    const leaseId = crypto.randomUUID()
    void client.ready.then(() => {
      if (!disposed) return client.addMagnet(magnet)
    }).catch(() => {})
    const offRevoked = client.onPlaybackRevoked((revokedInfoHash) => {
      if (revokedInfoHash === infoHash && !disposed) setPlaybackRevoked(true)
    })
    const offState = client.onState((snapshots) => {
      if (disposed) return
      const snap = snapshots.find((item) => item.infoHash === infoHash || magnetInfoHash(item.magnet) === infoHash) ?? null
      refRef.current = snap?.ref ?? null
      setSnapshot(snap)
      if (!snap?.files || leaseAcquired || leasePending) return
      leasePending = true
      leaseRef = snap.ref
      void client.acquirePlayback(leaseId, infoHash, snap.ref, fileIndex).then(
        () => {
          leasePending = false
          if (disposed) void client.releasePlayback(leaseId, infoHash, leaseRef).catch(() => {})
          else leaseAcquired = true
        },
        () => { leasePending = false },
      )
    })
    return () => {
      disposed = true
      offRevoked()
      offState()
      if (leaseAcquired) void client.releasePlayback(leaseId, infoHash, leaseRef).catch(() => {})
      refRef.current = null
    }
  }, [client, magnet, fileIndex])

  const readAt = async (offset: number, size: number, prioritize: boolean): Promise<ArrayBuffer> => {
    const ref = refRef.current
    if (!ref) throw new Error('torrent not ready')
    const fileSize = snapshot?.files?.files[fileIndex]?.size
    const clamped = fileSize != null ? Math.max(0, Math.min(size, fileSize - offset)) : size
    if (clamped === 0) return new ArrayBuffer(0)
    const data = await client.read(ref, fileIndex, offset, clamped, prioritize)
    const buffer = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data.buffer
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    return buffer as ArrayBuffer
  }

  const prioritizeFrom = (offset: number) => {
    const ref = refRef.current
    if (ref) void client.prioritizeFile(ref, fileIndex, Math.max(0, Math.floor(offset))).catch(() => {})
  }

  return {
    snapshot,
    engineGeneration: snapshot?.engineGeneration ?? 0,
    playbackRevoked,
    read: (offset, size) => readAt(offset, size, true),
    readQuiet: (offset, size) => readAt(offset, size, false),
    prioritizeFrom,
  }
}
