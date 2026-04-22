// Mirrors the JSON shapes produced by native/src/ripple_alerts.cpp.
// Keeping the union small and explicit so the engine can pattern-match
// without ad-hoc property checks.

export type AlertBase = { ts: number }

export type TorrentAddedAlert    = AlertBase & { type: 'torrent_added',    infoHash: string }
export type TorrentRemovedAlert  = AlertBase & { type: 'torrent_removed',  infoHash: string }
export type MetadataReceived     = AlertBase & {
  type: 'metadata_received', infoHash: string,
  files: { index: number, path: string, length: number }[]
}
export type TorrentFinished      = AlertBase & { type: 'torrent_finished', infoHash: string }
export type PieceFinished        = AlertBase & { type: 'piece_finished',   infoHash: string, piece: number }
export type StateUpdate          = AlertBase & {
  type: 'state_update',
  torrents: {
    infoHash: string
    downloadRate: number
    uploadRate: number
    numPeers: number
    totalWanted: number
    totalWantedDone: number
    progress: number
  }[]
}
export type ReadPiece            = AlertBase & { type: 'read_piece', infoHash: string, piece: number }
export type GenericAlert         = AlertBase & { type: string, message?: string }

// Note: GenericAlert is intentionally NOT in the Alert union. Including it
// would widen `type` to `string` and break discriminated narrowing. The
// engine treats unknown alerts as opaque (it never destructures them); UI
// code only handles the known shapes here.
export type Alert =
  | TorrentAddedAlert
  | TorrentRemovedAlert
  | MetadataReceived
  | TorrentFinished
  | PieceFinished
  | StateUpdate
  | ReadPiece
