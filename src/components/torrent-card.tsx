// Single row in the library and the watch sidebar. Shows progress, peers,
// rates, and offers play / remove actions.

import { Link } from 'react-router-dom'
import { css } from '@emotion/react'
import { Trash2, Play, ArrowDown, ArrowUp, User } from 'react-feather'

import { getHumanReadableByteString } from '../utils/bytes'
import { getRoutePath, Route } from '../router/path'
import type { ListItem } from '../worker/rpc'

const style = css`
  display: grid; grid-template-columns: 1fr auto; gap: 1.2rem;
  padding: 1.2rem 1.6rem; border: 1px solid #2a2a2a; border-radius: 0.6rem;
  background: #141414;

  .head { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
  .name { font-weight: 600; font-size: 1.6rem; }
  .hash { font-family: 'Fira Code', monospace; font-size: 1.1rem; color: #777; }
  .progress {
    height: 4px; background: #1f1f1f; border-radius: 2px; overflow: hidden;
    margin: 0.6rem 0;
  }
  .progress > div { height: 100%; background: #3a83ff; }
  .stats { display: flex; gap: 1.2rem; color: #aaa; font-size: 1.3rem; }
  .stats .item { display: flex; gap: 0.4rem; align-items: center; }
  .actions { display: flex; gap: 0.4rem; align-items: center; }
  .actions a, .actions button {
    background: transparent; border: 0; color: #aaa; cursor: pointer;
    padding: 0.6rem; border-radius: 0.4rem;
  }
  .actions a:hover, .actions button:hover { background: #1f1f1f; color: #fff; }
`

export type TorrentCardProps = {
  item: ListItem
  onRemove?: (infoHash: string) => void
}

const TorrentCard = ({ item, onRemove }: TorrentCardProps) => {
  const { status, files, infoHash } = item
  const pct = Math.round((status.progress ?? 0) * 100)
  const firstFileIndex = files[0]?.index ?? 0

  return (
    <div css={style}>
      <div>
        <div className='head'>
          <div>
            <div className='name'>{status.name || infoHash}</div>
            <div className='hash'>{infoHash}</div>
          </div>
          <div>{pct}%</div>
        </div>
        <div className='progress'><div style={{ width: `${pct}%` }} /></div>
        <div className='stats'>
          <div className='item'><User size={14}/>{status.numPeers}</div>
          <div className='item'><ArrowDown size={14}/>{getHumanReadableByteString(status.downloadRate)}/s</div>
          <div className='item'><ArrowUp   size={14}/>{getHumanReadableByteString(status.uploadRate)}/s</div>
          <div className='item'>{getHumanReadableByteString(status.totalWantedDone)} / {getHumanReadableByteString(status.totalWanted)}</div>
        </div>
      </div>
      <div className='actions'>
        <Link
          to={getRoutePath(Route.WATCH, { infoHash, fileIndex: firstFileIndex })}
          aria-label='Play'
        ><Play size={18}/></Link>
        <button onClick={() => onRemove?.(infoHash)} aria-label='Remove'>
          <Trash2 size={18}/>
        </button>
      </div>
    </div>
  )
}

export default TorrentCard
