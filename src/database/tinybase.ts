import { createIndexes, createMergeableStore, createRelationships } from 'tinybase/with-schemas'

const torrentListSchema = {
  infoHash: { type: 'string' },
  next: { type: 'string' },
} as const

const torrentSchema = {
  infoHash: { type: 'string' },
  title: { type: 'string' },
  description: { type: 'string' },
  embedded: { type: 'boolean' },
  magnet: { type: 'string' },
  torrentFile: { type: 'string' }
} as const

const torrentContentFileSchema = {
  torrentInfoHash: { type: 'string' },
  index: { type: 'number' },
  length: { type: 'number' },
  downloadedAt: { type: 'number' },
  accessedAt: { type: 'number' },
  name: { type: 'string' },
  start: { type: 'number' },
  end: { type: 'number' },
  pieceIndexStart: { type: 'number' },
  pieceIndexEnd: { type: 'number' },
  isPieceStartMultiFile: { type: 'boolean' },
  isPieceEndMultiFile: { type: 'boolean' },
} as const

export const store =
  createMergeableStore()
    .setTablesSchema({
      torrentList: torrentListSchema,
      torrents: torrentSchema,
      torrentsContentFiles: torrentContentFileSchema
    })

export const indexes = createIndexes(store)

indexes.setIndexDefinition(
  'torrentListValues',
  'torrentList',
  'next',
)

indexes.setIndexDefinition(
  'torrentsByInfoHash',
  'torrents',
  'infoHash',
)

indexes.setIndexDefinition(
  'torrentContentFilesByTorrentInfoHash',
  'torrentsContentFiles',
  'torrentInfoHash',
)

export const relationships = createRelationships(store)

relationships.setRelationshipDefinition(
  'torrentListToTorrents',
  'torrentList',
  'torrentList',
  'next',
)
relationships.setRelationshipDefinition(
  'torrentListItemToTorrent',
  'torrentList',
  'torrents',
  'infoHash',
)

relationships.setRelationshipDefinition(
  'torrentToContentFiles',
  'torrentsContentFiles',
  'torrents',
  'torrentInfoHash',
)
