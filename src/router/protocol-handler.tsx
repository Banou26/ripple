// PWA protocol handler entry for magnet: URIs. The webmanifest registers
// /protocol-handler?url=%s — the browser substitutes the magnet URI in.

import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { useEngine } from '../hooks/use-engine'
import { putTorrent } from '../store/torrents-db'
import { getRoutePath, Route } from './path'

const ProtocolHandler = () => {
  const engine = useEngine()
  const navigate = useNavigate()
  const [params] = useSearchParams()

  useEffect(() => {
    const url = params.get('magnet') ?? params.get('url') ?? ''
    if (!url.startsWith('magnet:')) {
      navigate(getRoutePath(Route.HOME))
      return
    }
    ;(async () => {
      const infoHash = await engine.add(url)
      await putTorrent({
        infoHash,
        name: url.match(/dn=([^&]+)/)?.[1] ?? infoHash,
        source: { kind: 'magnet', uri: url },
        addedAt: Date.now()
      })
      navigate(getRoutePath(Route.WATCH, { infoHash, fileIndex: 0 }))
    })().catch(() => navigate(getRoutePath(Route.HOME)))
  }, [engine, navigate, params])

  return <div style={{ padding: '2.4rem' }}>Opening magnet…</div>
}

export default ProtocolHandler
