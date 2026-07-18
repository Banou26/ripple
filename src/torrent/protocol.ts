import type { TorrentFiles, TorrentStatus } from 'libtorrent-wasm'

export const PROTOCOL_VERSION = 2
export const STORAGE_SCHEMA_VERSION = 1
export const ENGINE_LOCK_NAME = 'ripple:libtorrent-engine'
export const COORDINATOR_NAME = `ripple-torrent-v${PROTOCOL_VERSION}`

export type EnginePhase =
  | 'connecting'
  | 'waiting-for-lock'
  | 'waiting-for-engine-host'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'storage-unavailable'
  | 'incompatible'
  | 'fatal'

export type EngineHandle = {
  handle: number
  engineGeneration: number
  infoHash?: string
}

export type TorrentSnapshot = {
  handle: number
  infoHash: string | null
  magnet: string
  files: TorrentFiles | null
  status: TorrentStatus | null
  bitfield: { numPieces: number, pieceLength: number, length: number, pieces: Uint8Array } | null
}

export type Persisted = {
  infoHash: string
  magnet: string
  savePath: string
  addedAt: number
  started?: boolean
}

export type TorrentOperation =
  | 'add-magnet'
  | 'add-torrent-file'
  | 'read'
  | 'remove'
  | 'remove-missing'
  | 'acquire-playback'
  | 'release-playback'
  | 'prioritize-file'
  | 'prioritize-range'
  | 'pause'
  | 'resume'
  | 'import-list'
  | 'clear-list'
  | 'start'
  | 'checkpoint'
  | 'checkpoint-and-shutdown'

export type EngineRequest = {
  kind: 'request'
  id: number
  op: TorrentOperation
  payload?: any
}

export type EngineResponse = {
  kind: 'response'
  id: number
  ok: boolean
  value?: any
  error?: string
}

export type TorrentEventTopic = 'phase' | 'state' | 'list' | 'storage' | 'worker-error'

export type EngineEvent = {
  kind: 'event'
  topic: TorrentEventTopic
  payload?: any
}

export type EngineWorkerMessage = EngineResponse | EngineEvent

export type EngineBootstrapMessage = {
  kind: 'attach-engine'
  port: MessagePort
}

export type ClientHello = {
  kind: 'hello'
  protocolVersion: number
  buildId: string
  clientId: string
  capabilities: {
    webLocks: boolean
    engineHost: boolean
  }
}

export type ClientRequest = EngineRequest & {
  engineGeneration: number
}

export type ClientControlMessage =
  | ClientHello
  | ClientRequest
  | { kind: 'cancel', id: number }
  | { kind: 'disconnect' }
  | { kind: 'liveness-ready' }
  | { kind: 'engine-host-error', assignmentId: string, error: string }
  | { kind: 'engine-host-stopped', assignmentId: string }

export type CoordinatorWelcome = {
  kind: 'welcome'
  protocolVersion: number
  coordinatorId: string
  coordinatorBuildId: string
  actorId: string
  livenessLockName: string
  engineGeneration: number
  phase: EnginePhase
}

export type CoordinatorResponse = EngineResponse & {
  engineGeneration: number
}

export type CoordinatorEvent = {
  kind: 'event'
  topic: TorrentEventTopic | 'playback-revoked'
  sequence: number
  engineGeneration: number
  payload?: any
}

export type CoordinatorControlMessage =
  | CoordinatorWelcome
  | CoordinatorResponse
  | CoordinatorEvent
  | { kind: 'become-engine-host', assignmentId: string, engineGeneration: number, port: MessagePort }
  | { kind: 'stop-engine-host', assignmentId: string }

export type RuntimeMode = 'shared' | 'dedicated'
