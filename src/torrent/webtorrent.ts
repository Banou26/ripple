import type { RxDocument } from 'rxdb'
import type { Instance } from '@types/webtorrent'

import { TorrentDocument, torrentCollection } from './collection'
import { database, leaderElector } from './database'
import WebTorrent from 'webtorrent/dist/webtorrent.min.js'

import { queuedDebounceWithLastCall } from 'queue-utils'

export const webtorrent = new WebTorrent({
  trackers: [],
  downloadLimit: 10000
}) as Instance

console.log('webtorrent', webtorrent)

const addTorrent = async (torrentDoc: RxDocument<TorrentDocument>) => {
  console.log('addTorrent', torrentDoc)
  const { torrentFile } = torrentDoc
  if (!torrentFile) throw new Error('torrent file and magnet not set')

  console.log('adding torrent: ', torrentFile)
  const torrent = webtorrent.add(
    torrentFile,
    {
      announce: [
        'd3NzOi8vdHJhY2tlci53ZWJ0b3JyZW50LmRldg==',
        'd3NzOi8vdHJhY2tlci5maWxlcy5mbTo3MDczL2Fubm91bmNl',
        'aHR0cDovL255YWEudHJhY2tlci53Zjo3Nzc3L2Fubm91bmNl'
      ].map(atob)
    }
  )

  const debounce = queuedDebounceWithLastCall(500, (torrentDoc: RxDocument<TorrentDocument>) => {
    if (!torrentDoc.p2p) return
    torrentDoc.incrementalModify((doc) => {
      doc.progress = torrent.progress
      doc.downloaded = torrent.downloaded
      doc.downloadSpeed = torrent.downloadSpeed
      doc.uploaded = torrent.uploaded
      doc.uploadSpeed = torrent.uploadSpeed
      doc.ratio = torrent.ratio
      doc.remainingTime = torrent.timeRemaining

      doc.peersCount = torrent.numPeers
      doc.seedersCount = torrent.numPeers
      doc.leechersCount = torrent.numPeers

      doc.status =
        torrent.done ? 'finished' :
        torrent.paused ? 'paused' :
        'downloading'

      return doc
    })
  })

  console.log('torrent', torrent)
  torrent.on('done', () => {
    console.log('done')
    torrentDoc.incrementalModify((doc) => {
      doc.status = torrent.paused ? 'finished' : 'seeding'
      return doc
    })
  })
  torrent.on('download', () => {
    console.log('download')
    debounce(torrentDoc)
  })
  torrent.on('error', (err) => {
    console.error(err)
  })
  torrent.on('infoHash', () => {
    console.log('infoHash')
    torrentDoc.incrementalModify((doc) => {
      doc.infoHash = torrent.infoHash
      return doc
    })
  })
  torrent.on('metadata', () => {
    console.log('metadata')
    torrentDoc.incrementalModify((doc) => {
      doc.name = torrent.name
      return doc
    })
  })
  torrent.on('ready', () => {
    console.log('ready')
    torrentDoc.incrementalModify((doc) => {
      doc.status =
        torrent.done ? 'finished' :
        torrent.paused ? 'paused' :
        'downloading'
      return doc
    })
  })
  // torrent.on('warning', (err) => {
  //   console.warn(err)
  // })
  torrent.on('wire', (wire) => {
    wire.on('bitfield', (ev) => {
      console.log('bitfield', ev)
    })
    wire.on('cancel', (ev) => {
      console.log('cancel', ev)
    })
    wire.on('choke', (ev) => {
      console.log('choke', ev)
    })
    wire.on('download', (ev) => {
      console.log('download', ev)
    })
    wire.on('extended', (ev) => {
      console.log('extended', ev)
    })
    wire.on('handshake', (ev) => {
      console.log('handshake', ev)
    })
    wire.on('have', (ev) => {
      console.log('have', ev)
    })
    wire.on('interested', (ev) => {
      console.log('interested', ev)
    })
    wire.on('keep-alive', (ev) => {
      console.log('keep', ev)
    })
    wire.on('piece', (ev) => {
      console.log('piece', ev)
    })
    wire.on('port', (ev) => {
      console.log('port', ev)
    })
    wire.on('request', (ev) => {
      console.log('request', ev)
    })
    wire.on('timeout', (ev) => {
      console.log('timeout', ev)
    })
    wire.on('unchoke', (ev) => {
      console.log('unchoke', ev)
    })
    wire.on('uninterested', (ev) => {
      console.log('uninterested', ev)
    })
    wire.on('unknownmessage', (ev) => {
      console.log('unknownmessage', ev)
    })
    wire.on('upload', (ev) => {
      console.log('upload', ev)
    })
    wire.on('close', () => {
      torrentDoc.incrementalModify((doc) => {
        doc.peers = doc.peers.filter((peer) => peer.ip !== wire.remoteAddress || peer.port !== wire.remotePort)
        return doc
      })
      console.log('close')
    })
    torrentDoc.incrementalModify((doc) => {
      doc.peers = [
        ...doc.peers, {
          ip: wire.remoteAddress,
          port: wire.remotePort
        }
      ]
      return doc
    })
    console.log('wire', wire)
  })
  torrent.on('download', () => {
    console.log('download', torrent.progress)
  })
  torrent.on('upload', () => {
    console.log('upload', torrent.progress)
  })
  torrent.on('noPeers', (announceType) => {
    torrentDoc.incrementalModify((doc) => {
      doc.peers = []
      return doc
    })
    console.log('noPeers', announceType)
  })
}

const removeTorrent = async (torrentDoc: RxDocument<TorrentDocument>) => {
  const { infoHash } = torrentDoc
  if (!infoHash) throw new Error('infoHash not set')
  const torrent = webtorrent.get(infoHash)
  if (!torrent) throw new Error('torrent not found')
  // torrent.destroy({ destroyStore: true })
  webtorrent.remove(infoHash, { destroyStore: true })
}

const disableTorrent = async (torrentDoc: WebTorrent.Torrent) => {
  const { infoHash } = torrentDoc
  if (!infoHash) throw new Error('infoHash not set')
  const torrent = webtorrent.get(infoHash)
  if (!torrent) throw new Error('torrent not found')
  webtorrent.remove(infoHash, { destroyStore: false })
  // torrent.destroy({ destroyStore: true })
}

database
  .waitForLeadership()
  .then(() => {
    console.log('The current tab has been elected as leader')

    torrentCollection
      .find()
      .$
      .subscribe(async (torrentDocuments: RxDocument<TorrentDocument>[]) => {
        const filteredTorrentDocs = torrentDocuments.filter((torrentDoc) => torrentDoc.p2p && !torrentDoc.proxy)
        console.log('torrents', torrentDocuments)

        for (const torrent of webtorrent.torrents) {
          if (!filteredTorrentDocs.find((torrentDoc) => torrentDoc.infoHash === torrent.infoHash)) {
            console.log('disableTorrent', torrent.infoHash)
            await disableTorrent(torrent)
          }
        }

        for (const torrentDoc of filteredTorrentDocs) {
          if (await webtorrent.get(torrentDoc.infoHash)) {
            console.log('torrent already set', torrentDoc.infoHash)
            continue
          }
          await addTorrent(torrentDoc)
        }
      })
  })


leaderElector.onduplicate = async () => {
  console.log('Another leader-elector instance has been found.')
  window.location.reload()
}