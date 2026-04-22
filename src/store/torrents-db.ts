// Persisted torrent metadata for the library view. The engine's session
// state covers DHT/peers; this is the per-torrent application metadata
// (display name, source magnet/file, last-watched file index, added time).
// Backed by IndexedDB via `idb`.

import { openDB, type IDBPDatabase } from 'idb'

export type TorrentRecord = {
  infoHash: string
  name: string
  source: { kind: 'magnet', uri: string } | { kind: 'file', bytes: ArrayBuffer }
  addedAt: number
  lastFileIndex?: number
}

const DB_NAME = 'ripple'
const STORE   = 'torrents'

let dbPromise: Promise<IDBPDatabase> | null = null
const db = () => dbPromise ??= openDB(DB_NAME, 1, {
  upgrade (d) {
    if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'infoHash' })
  }
})

export const putTorrent  = async (rec: TorrentRecord) => (await db()).put(STORE, rec)
export const getTorrent  = async (infoHash: string)   => (await db()).get(STORE, infoHash) as Promise<TorrentRecord | undefined>
export const allTorrents = async ()                   => (await db()).getAll(STORE)        as Promise<TorrentRecord[]>
export const delTorrent  = async (infoHash: string)   => (await db()).delete(STORE, infoHash)
