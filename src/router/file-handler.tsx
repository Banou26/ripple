// PWA file handler entry. The webmanifest registers this route as a
// `application/x-bittorrent` handler, so the browser launches us with the
// dropped/opened .torrent file in `launchQueue`.

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import { useEngine } from '../hooks/use-engine'
import { putTorrent } from '../store/torrents-db'
import { getRoutePath, Route } from './path'

const FileHandler = () => {
  const engine = useEngine()
  const navigate = useNavigate()

  useEffect(() => {
    const lq = (window as any).launchQueue
    if (!lq?.setConsumer) {
      navigate(getRoutePath(Route.HOME))
      return
    }
    lq.setConsumer(async (params: { files: FileSystemFileHandle[] }) => {
      const handle = params.files?.[0]
      if (!handle) { navigate(getRoutePath(Route.HOME)); return }
      const file = await handle.getFile()
      const buf = await file.arrayBuffer()
      const infoHash = await engine.add(new Uint8Array(buf))
      await putTorrent({
        infoHash,
        name: file.name,
        source: { kind: 'file', bytes: buf },
        addedAt: Date.now()
      })
      navigate(getRoutePath(Route.WATCH, { infoHash, fileIndex: 0 }))
    })
  }, [engine, navigate])

  return <div style={{ padding: '2.4rem' }}>Opening torrent file…</div>
}

export default FileHandler
