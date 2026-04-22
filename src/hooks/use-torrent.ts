// Adds (if needed) and tracks a single torrent. Replaces the old
// utils/torrent.ts useTorrent hook. The engine handles persistence; here we
// just orchestrate add/select/status.

import { useEffect, useState } from 'react'

import { useEngine } from './use-engine'
import type { TorrentSnapshot, FileInfo } from '../engine/torrent'

export type UseTorrentArgs = {
  magnet?: string
  torrentFile?: Uint8Array
  fileIndex?: number
}

export type UseTorrentValue = {
  infoHash?: string
  files?: FileInfo[]
  status?: TorrentSnapshot
  loading: boolean
  error?: string
}

export const useTorrent = ({ magnet, torrentFile, fileIndex }: UseTorrentArgs): UseTorrentValue => {
  const engine = useEngine()
  const [state, setState] = useState<UseTorrentValue>({ loading: true })

  useEffect(() => {
    if (!magnet && !torrentFile) {
      setState({ loading: false })
      return
    }
    let cancelled = false
    let infoHash: string | undefined
    let unsub: (() => Promise<void>) | undefined

    ;(async () => {
      try {
        infoHash = await engine.add(torrentFile ?? magnet!, { storageId: undefined })
        if (cancelled) return
        if (typeof fileIndex === 'number') await engine.select(infoHash, fileIndex)

        const refreshAll = async () => {
          if (cancelled || !infoHash) return
          const list = await engine.list()
          const me = list.find(t => t.infoHash === infoHash)
          if (!me) return
          setState({
            loading: false,
            infoHash,
            files: me.files,
            status: me.status
          })
        }
        await refreshAll()

        unsub = await engine.subscribe(alert => {
          if (!infoHash) return
          if ((alert.type === 'metadata_received' || alert.type === 'torrent_added') && alert.infoHash === infoHash) {
            refreshAll()
          } else if (alert.type === 'state_update') {
            const upd = alert.torrents.find(t => t.infoHash === infoHash)
            if (upd) setState(prev => prev.status ? { ...prev, status: { ...prev.status, ...upd } } : prev)
          }
        })
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: (e as Error).message })
      }
    })()

    return () => {
      cancelled = true
      if (unsub) unsub().catch(() => {})
    }
  }, [engine, magnet, torrentFile, fileIndex])

  return state
}
