// Wire protocol between any tab and the SharedWorker engine host.
//
// Requests are id-tagged and answered with either a Result or an Error of
// the same id. Stream subscriptions (alerts, torrent stats, file reads) use
// a long-lived id whose responses keep arriving until cancelled.

import type { Alert } from '../engine/alerts'
import type { TorrentSnapshot, FileInfo } from '../engine/torrent'

export type Req =
  | { kind: 'list' }
  | { kind: 'add',     input: string | Uint8Array, storageId?: string }
  | { kind: 'remove',  infoHash: string, deleteFiles?: boolean }
  | { kind: 'status',  infoHash: string }
  | { kind: 'select',  infoHash: string, fileIndex: number }
  | { kind: 'deadline', infoHash: string, piece: number, ms: number }
  | { kind: 'read',    infoHash: string, fileIndex: number, offset: number, length: number }
  | { kind: 'subscribe' }                       // alerts stream
  | { kind: 'cancel',  subId: number }

export type ListItem = { infoHash: string, files: FileInfo[], status: TorrentSnapshot }

export type Res =
  | { kind: 'list',     torrents: ListItem[] }
  | { kind: 'add',      infoHash: string }
  | { kind: 'remove' }
  | { kind: 'status',   status: TorrentSnapshot }
  | { kind: 'select' }
  | { kind: 'deadline' }
  | { kind: 'read',     bytes: ArrayBuffer }    // transferable
  | { kind: 'subscribe', subId: number }
  | { kind: 'event',    subId: number, alert: Alert }
  | { kind: 'cancel' }
  | { kind: 'error',    message: string }

export type Envelope<T> = { id: number, payload: T }
