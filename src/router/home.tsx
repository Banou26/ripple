// HOME — torrent library. Lists every torrent the engine currently knows
// about, plus an add-torrent panel.

import { useCallback } from 'react'
import { css } from '@emotion/react'

import AddTorrent  from '../components/add-torrent'
import TorrentCard from '../components/torrent-card'
import { useEngine }   from '../hooks/use-engine'
import { useTorrents } from '../hooks/use-torrents'
import { delTorrent }  from '../store/torrents-db'

const style = css`
  display: flex; flex-direction: column; gap: 1.6rem;
  padding: 2.4rem; max-width: 96rem; margin: 0 auto;

  h1 { font-weight: 600; font-size: 2.4rem; }
  .empty { color: #777; padding: 2rem 0; }
`

const Home = () => {
  const engine = useEngine()
  const items  = useTorrents()

  const remove = useCallback(async (infoHash: string) => {
    await engine.remove(infoHash, true)
    await delTorrent(infoHash)
  }, [engine])

  return (
    <div css={style}>
      <h1>Library</h1>
      <AddTorrent/>
      {items.length === 0 && <div className='empty'>No torrents yet. Paste a magnet or drop a .torrent above.</div>}
      {items.map(item => <TorrentCard key={item.infoHash} item={item} onRemove={remove}/>)}
    </div>
  )
}

export default Home
