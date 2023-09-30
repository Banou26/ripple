import type { TorrentDocument } from '../torrent/collection'

import { serverProxyFetch } from '@fkn/lib'
import { css } from '@emotion/react'
import { useEffect, useState } from 'react'
import { RxDocument } from 'rxdb'
import { useRxCollection, useRxQuery } from 'rxdb-hooks'

import { getHumanReadableByteString } from '../utils/bytes'
import { Download, Upload, Divide, ArrowDownCircle, ArrowUpCircle, CheckSquare, Square, Users, UserCheck } from 'react-feather'
import { Link } from 'react-router-dom'

const style = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;

  width: 100%;

  .category {
    width: 100%;
    height: 100%;

    & > .title {
      font-size: 2rem;
      font-weight: bold;
      width: 100%;
      height: 4rem;
      padding: 1rem;
      border-bottom-color: rgb(48, 52, 54);
      background-color: rgb(35, 38, 40);
      /* border-bottom: 1px solid #fff;
      background-color: #2f2f2f; */
    }

    .items {

    }

    .item {
      display: flex;
      width: 100%;
      height: 12rem;
      border-bottom-color: rgb(48, 52, 54);
      background-color: rgb(35, 38, 40);
      /* border-bottom: 1px solid #fff;
      background-color: #2f2f2f; */

      .main {
        display: flex;
        padding: 1rem;

        .preview {
          height: 10rem;
          margin-right: 1rem;
        }

        .content {
          display: flex;
          flex-direction: column;
          margin-left: 1rem;

          .name {
            font-size: 2rem;
            font-weight: bold;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .size {
            margin-top: 1rem;
            color: #aaa;
            font-weight: bold;
          }

          .sources {
            display: flex;

            margin-top: auto;

            button {
              padding: .25rem .5rem;
              margin-right: 0.5rem;
              border-radius: 0.5rem;
              border: none;
              background-color: rgb(24, 26, 27);
              cursor: pointer;

              display: flex;
              align-items: center;
              justify-content: center;
              gap: .25rem;

              font-weight: bold;
              color: #aaa;

              svg {
                width: 1.5rem;
                height: 1.5rem;
                stroke-width: 3;
              }

              &.active {
                background-color: #2f2f2f;
                color: #fff;
              }
            }
          }
        }
      }

      .info {
        display: flex;
        margin-left: auto;
        justify-content: center;
        flex-direction: column;
        padding: 2rem;
        gap: .5rem;

        width: 100rem;

        font-weight: bold;
        color: #aaa;

        /* svg {
          stroke-width: 3;
        } */


        .progress-title {
          display: flex;
          align-items: center;
          justify-content: space-between;

          .status {
            font-size: 1.5rem;
            font-weight: bold;
            margin-right: 1rem;
            color: #aaa;
          }

          .remaining {
            font-size: 1.5rem;
            font-weight: bold;
            color: #aaa;
          }
        }

        .progress-bar {
          width: 100%;
          height: .25rem;
          margin-bottom: 0.5rem;
          background-color: #3d3d3d;

          .inner {
            height: 100%;
            background-color: #fff;
          }
        }

        .torrent-info {
          display: flex;
          justify-content: space-between;

          .peers {
            display: flex;
            align-items: center;
            gap: 1rem;

            span {
              display: flex;
              align-items: center;
              gap: .5rem;
            }
          }

          .stats {
            display: flex;
            align-items: center;
            gap: 2rem;

            span {
              display: flex;
              align-items: center;
              gap: .5rem;
            }
          }
        }
      }

      .highlight {
        color: #fff;
      }


      &:nth-of-type(-n+2) {
        border-top: 1px solid rgb(48, 52, 54);
      }

      :last-child {
        border-bottom: none;
      }
    }
  }
`

const getDuckDuckGoToken = async (name: string) => {
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(name)}&iax=images&ia=images`
  const res = await serverProxyFetch(url, {  }).then(res => res.text())
  const result = res.match(/,vqd="(.*?)"/)
  return result[1]
}

const getFirstGoogleImageResult = async (name: string) => {
  const token = await getDuckDuckGoToken(name)
  const res = await serverProxyFetch(`https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${encodeURIComponent(name).replaceAll('-', '%2D')}&vqd=${token}&f=,,,,,&p=1`, {  }).then(res => res.text())
  const dom = new DOMParser().parseFromString(res, 'text/html')
  const results = JSON.parse(dom.body.textContent || '{results:[]}').results
  return results[0].image
}

const TorrentItem = ({ torrent }: { torrent: RxDocument<TorrentDocument> }) => {
  const [imgUrl, setImgUrl] = useState<string | undefined>(undefined)

  useEffect(() => {
    getFirstGoogleImageResult(torrent.name).then(setImgUrl)
  }, [])

  const toggleP2P = () => {
    torrent.update({ $set: { p2p: !torrent.p2p } })
  }

  const toggleProxy = () => {
    torrent.update({ $set: { proxy: !torrent.proxy } })
  }

  const remainingTimeString = new Date(torrent.remainingTime)?.toTimeString?.().split(' ')[0]?.replaceAll('00:', '') ?? '00:00'

  return (
    <div key={torrent.infoHash} className="item">
      <div className="main">
        <img className="preview" src={imgUrl} alt="" />
        <div className="content">
          <div className="name">{torrent.name}</div>
          <span className="size">{getHumanReadableByteString(torrent.torrentFile.length)}</span>
          <div className="sources">
            <button className={torrent.p2p && !torrent.proxy ? 'active' : ''} onClick={toggleP2P}>{torrent.p2p ? <CheckSquare/> : <Square/>} P2P</button>
            <button className={torrent.proxy ? 'active' : ''} onClick={toggleProxy}>{torrent.proxy ? <CheckSquare/> : <Square/>} VPN*</button>
          </div>
        </div>
      </div>
      <div className="info">
        <div className="progress-title">
          <span className="status">
            {
              torrent.status === 'downloading' && `Downloading ${(torrent.progress * 100).toFixed(2)}%`
            }
            {
              torrent.status === 'finished' && 'Finished'
            }
            {
              torrent.status === 'seeding' && 'Seeding'
            }
            {
              torrent.status === 'paused' && 'Paused'
            }
          </span>
          <span className="remaining">
            {
              torrent.status === 'downloading' && (
                <>
                  <span className="highlight">
                    {remainingTimeString}
                  </span>
                  &nbsp;
                  <span>remaining</span>
                </>
              )
            }
          </span>
        </div>
        <div className="progress-bar">
          <div className="inner" style={{ width: `${torrent.progress * 100}%`, height: '100%', backgroundColor: '#fff' }} />
        </div>
        <div className="torrent-info">
          <div className="peers">
            {
              torrent.p2p && !torrent.proxy && (
                <>
                  <span><UserCheck size={20}/> {torrent.peers.length}</span>
                  <span><Users size={20}/> {torrent.peers.length}</span>
                  <span>
                    <Divide size={22}/>
                    <span>{torrent.ratio?.toFixed(2)}</span>
                  </span>
                </>
              )
            }
          </div>
          <div className="stats">
            {
              torrent.p2p && !torrent.proxy && (
                <span>
                  <ArrowUpCircle size={20}/>
                  <span className="highlight">{getHumanReadableByteString(torrent.uploadSpeed ?? 0)}/s</span>
                </span>
              )
            }
            {
              torrent.status === 'downloading' && (
                <span>
                  <ArrowDownCircle size={20}/>
                  <span className="highlight">{getHumanReadableByteString(torrent.downloadSpeed ?? 0)}/s</span>
                </span>
              )
            }
            {
              torrent.p2p && !torrent.proxy && (
                <span>
                  <Upload size={22}/>
                  <span className="highlight">{getHumanReadableByteString(torrent.uploaded ?? 0)}</span>
                  <span>/ {getHumanReadableByteString(torrent.torrentFile.length)}</span>
                </span>
              )
            }
            <span>
              <Download size={22}/>
              <span className="highlight">{getHumanReadableByteString(torrent.downloaded ?? 0)}</span>
              <span>/ {getHumanReadableByteString(torrent.torrentFile.length)}</span>
            </span>
          </div>
        </div>
      </div>
      <div className="actions">
        <Link to={`/watch/${torrent.infoHash}`} className="play">
          <button>play</button>
        </Link>
      </div>
    </div>
  )
}

export const TorrentList = ({ ...rest }) => {
  const collection = useRxCollection<TorrentDocument>('torrents')
  const downloadingTorrentQuery = collection?.find({ selector: { status: { $in: ['downloading', 'paused'] } } }).sort({ addedAt: 'asc' })
  const { result: downloadingTorrents } = useRxQuery(downloadingTorrentQuery)
  const completedTorrentQuery = collection?.find({ selector: { status: { $in: ['finished', 'seeding'] } } }).sort({ addedAt: 'asc' })
  const { result: completedTorrents } = useRxQuery(completedTorrentQuery)
  console.log('downloadingTorrents', downloadingTorrents)
  console.log('completedTorrents', completedTorrents)

  return (
    <div css={style} {...rest}>
      <div className="category">
        <div className="title">Downloading</div>
        {
          !downloadingTorrents?.length && (
            <div className="items">
              <div className="item">
                <div className="main">
                  <div className="content">
                    <div className="name">No Torrents</div>
                    <div>
                      Drop or Paste files or magnets to start downloading
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )
        }
        <div className="items">
          {
            downloadingTorrents?.map(torrent => (
              <TorrentItem
                key={torrent.infoHash}
                torrent={torrent}
              />
            ))
          }
        </div>
      </div>
      <div className="category">
        <div className="title">Completed</div>
        <div className="items">
          {
            completedTorrents?.map(torrent => (
              <TorrentItem
                key={torrent.infoHash}
                torrent={torrent}
              />
            ))
          }
        </div>
      </div>
    </div>
  )
}

export default TorrentList