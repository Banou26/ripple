import type { Instance } from 'parse-torrent'
import type { RxDatabase, RxCollection, RxJsonSchema, RxDocument } from 'rxdb'
import { TorrentFile } from 'webtorrent'
import { database } from './database'

type TorrentStatus =
  'checking_files' |
  'downloading_metadata' |
  'downloading' |
  'finished' |
  'seeding' |
  'unused_enum_for_backwards_compatibility_allocating' |
  'checking_resume_data'
// 'idle' | 'downloading' | 'paused' | 'seeding' | 'error'

export type Torrent = {
  infoHash: string
  magnet?: string
  name?: string
  torrentFile?: Instance
  status?: TorrentStatus
  progress: number
  size: number
  p2p: boolean
}

export type Collection = RxCollection<TorrentDocType, TorrentDocMethods, TorrentCollectionMethods>

export type TorrentDocType = Torrent

export type TorrentDocMethods = {
  // scream: (v: string) => string
}

export type TorrentDocument = RxDocument<TorrentDocType, TorrentDocMethods>

export type TorrentCollectionMethods = {
  countAllDocuments: () => Promise<number>
}

export type TorrentCollection = RxCollection<TorrentDocType, TorrentDocMethods, TorrentCollectionMethods>

export type MyDatabaseCollections = {
  torrents: TorrentCollection
}

export type TorrentDB = RxDatabase<MyDatabaseCollections>
// magnet:?xt=urn:btih:82eb57b8028a718a30dd75f9150e3a5e97b73239&dn=%5BSubsPlease%5D+Mushoku+Tensei+S2+-+11+(1080p)+%5BF70DC34C%5D.mkv&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com
const torrentSchema: RxJsonSchema<TorrentDocType> = {
  title: 'Torrent schema',
  description: 'Describes a torrent',
  version: 0,
  primaryKey: 'infoHash',
  type: 'object',
  properties: {
    infoHash: {
      type: 'string',
      maxLength: 255
    },
    magnet: { type: 'string' },
    name: { type: 'string' },
    torrentFile: { type: 'object' },
    status: { type: 'string' },
    progress: { type: 'number' },
    size: { type: 'number' },
    p2p: { type: 'boolean' }
  },
  required: ['infoHash']
}

const torrentDocMethods: TorrentDocMethods = {
  // scream: function(this: TorrentDocument, what: string) {
  //   return this.id + ' screams: ' + what.toUpperCase()
  // }
}

const torrentCollectionMethods: TorrentCollectionMethods = {
  countAllDocuments: async function(this: TorrentCollection) {
    return (await this.find().exec()).length
  }
}

export const torrentCollection = await database.addCollections({
  torrents: {
    schema: torrentSchema,
    methods: torrentDocMethods,
    statics: torrentCollectionMethods
  }
})

export const addTorrent = async (torrentDocument: TorrentDocType) => {
  await database.torrents.insert(torrentDocument)
}
