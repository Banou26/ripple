// WATCH — primary playback route. Hosts the same MediaPlayer surface as
// EMBED but with sidebar/library context. URL params: /watch/:infoHash/:fileIndex?

import { useParams, useNavigate } from 'react-router-dom'
import { useMemo, useEffect } from 'react'
import { css } from '@emotion/react'

import { useEngine } from '../hooks/use-engine'
import { useTorrents } from '../hooks/use-torrents'
import TorrentCard from '../components/torrent-card'
import Embed from './embed'
import { getRoutePath, Route } from './path'

const style = css`
  display: grid; grid-template-columns: 32rem 1fr; height: 100vh; min-height: 0;

  aside {
    border-right: 1px solid #1f1f1f; overflow-y: auto;
    display: flex; flex-direction: column; gap: 1.2rem; padding: 1.2rem;
  }
  main { min-width: 0; min-height: 0; position: relative; }
`

const Watch = () => {
  const params = useParams<{ infoHash: string, fileIndex?: string }>()
  const navigate = useNavigate()
  const engine = useEngine()
  const items  = useTorrents()

  const fileIndex = useMemo(() => Number(params.fileIndex ?? 0), [params.fileIndex])

  useEffect(() => {
    if (params.infoHash) {
      engine.select(params.infoHash, fileIndex).catch(() => {})
    }
  }, [engine, params.infoHash, fileIndex])

  const search = new URLSearchParams()
  // Embed reads `magnet` (base64) + `fileIndex` from query params; for the
  // in-app navigation we already have the torrent loaded, so we just hand
  // it the fileIndex and skip magnet so it doesn't re-add.
  search.set('infoHash', params.infoHash ?? '')
  search.set('fileIndex', String(fileIndex))
  // Push the params into the URL the embed reads.
  if (typeof window !== 'undefined') {
    const desired = `?${search.toString()}`
    if (window.location.search !== desired) {
      window.history.replaceState({}, '', window.location.pathname + desired)
    }
  }

  return (
    <div css={style}>
      <aside>
        {items.length === 0 && <div>No torrents yet — <a onClick={() => navigate(getRoutePath(Route.HOME))}>add one</a>.</div>}
        {items.map(it => <TorrentCard key={it.infoHash} item={it}/>)}
      </aside>
      <main>
        <Embed/>
      </main>
    </div>
  )
}

export default Watch
