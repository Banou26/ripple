import type { LibtorrentSession } from './wasm-loader'

export type FileInfo = {
  index: number
  path: string
  length: number
}

export type TorrentSnapshot = {
  infoHash: string
  name: string
  totalWanted: number
  totalWantedDone: number
  downloadRate: number
  uploadRate: number
  numPeers: number
  numSeeds: number
  state: number
  progress: number
  isPaused: boolean
}

// One Torrent instance per added torrent. Holds metadata once it's known and
// exposes the operations the UI needs without leaking the raw session.
export class Torrent {
  readonly infoHash: string
  files: FileInfo[] = []
  metadataReady = false

  constructor (
    private readonly session: LibtorrentSession,
    infoHash: string
  ) {
    this.infoHash = infoHash
  }

  applyMetadata (files: FileInfo[]) {
    this.files = files
    this.metadataReady = true
  }

  status (): TorrentSnapshot {
    return this.session.torrentStatus(this.infoHash) as TorrentSnapshot
  }

  // Make the file the engine prioritizes. priority=0 disables, 1=normal,
  // 7=highest. We map "selected for streaming" to 7 and everything else to 0.
  selectFile (fileIndex: number) {
    for (const f of this.files) {
      this.session.setFilePriority(this.infoHash, f.index, f.index === fileIndex ? 7 : 0)
    }
  }

  // For streaming: tell libtorrent we want this piece soon. Used by the
  // ReadableStream adapter to bias the picker toward the current playhead.
  setPieceDeadline (piece: number, msFromNow: number) {
    this.session.setPieceDeadline(this.infoHash, piece, msFromNow)
  }

  // Streamable read of a (file, offset, length) byte range. Resolves with
  // a Uint8Array. The libtorrent side fulfills this via piece reads through
  // the OPFS disk_interface.
  read (fileIndex: number, offset: number, length: number): Promise<Uint8Array> {
    return this.session.read(this.infoHash, fileIndex, offset, length)
  }

  // ReadableStream over a file, suitable for the media player. Uses
  // setPieceDeadline to keep the picker honest about the read head.
  stream (fileIndex: number, opts?: { start?: number, end?: number, chunkSize?: number }): ReadableStream<Uint8Array> {
    const file = this.files[fileIndex]
    if (!file) throw new Error(`unknown file index ${fileIndex}`)
    const start    = opts?.start ?? 0
    const end      = opts?.end   ?? file.length
    const chunk    = opts?.chunkSize ?? 256 * 1024
    let offset = start
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (offset >= end) { controller.close(); return }
        const len = Math.min(chunk, end - offset)
        const data = await this.read(fileIndex, offset, len)
        controller.enqueue(data)
        offset += data.byteLength
      }
    })
  }

  remove (deleteFiles: boolean) {
    this.session.removeTorrent(this.infoHash, deleteFiles)
  }
}
