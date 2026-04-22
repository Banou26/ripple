import type { RippleEngine } from './wasm-loader'

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

// One Torrent instance per added torrent. Holds metadata once it's known
// and exposes the operations the UI needs without leaking the raw engine.
export class Torrent {
  readonly infoHash: string
  files: FileInfo[] = []
  metadataReady = false

  constructor (
    private readonly rt: RippleEngine,
    infoHash: string
  ) {
    this.infoHash = infoHash
  }

  applyMetadata (files: FileInfo[]) {
    this.files = files
    this.metadataReady = true
  }

  status (): Promise<TorrentSnapshot> {
    return this.rt.status(this.infoHash) as Promise<TorrentSnapshot>
  }

  // Priority: 0=none, 1=normal, 2=high, 3=readahead, 4=now.
  async selectFile (fileIndex: number): Promise<void> {
    for (const f of this.files) {
      await this.rt.setFilePriority(this.infoHash, f.index, f.index === fileIndex ? 4 : 0)
    }
  }

  // Bias the picker for streaming. `bytes` is the lookahead window from
  // the current read offset.
  setReadahead (fileIndex: number, offset: number, bytes: number): Promise<void> {
    return this.rt.setReadahead(this.infoHash, fileIndex, offset, bytes)
  }

  read (fileIndex: number, offset: number, length: number): Promise<Uint8Array> {
    return this.rt.read(this.infoHash, fileIndex, offset, length)
  }

  // ReadableStream over a file. Sets a readahead window on open and pulls
  // fixed-size chunks. anacrolix's Reader blocks on pieces as needed, so
  // the await on `read` naturally gates on download progress.
  stream (fileIndex: number, opts?: { start?: number, end?: number, chunkSize?: number }): ReadableStream<Uint8Array> {
    const file = this.files[fileIndex]
    if (!file) throw new Error(`unknown file index ${fileIndex}`)
    const start = opts?.start ?? 0
    const end   = opts?.end   ?? file.length
    const chunk = opts?.chunkSize ?? 256 * 1024
    let offset = start
    let primed = false
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (!primed) {
          await this.setReadahead(fileIndex, offset, chunk * 8).catch(() => {})
          primed = true
        }
        if (offset >= end) { controller.close(); return }
        const len = Math.min(chunk, end - offset)
        const data = await this.read(fileIndex, offset, len)
        controller.enqueue(data)
        offset += data.byteLength
      }
    })
  }

  remove (deleteFiles: boolean): Promise<void> {
    return this.rt.removeTorrent(this.infoHash, deleteFiles)
  }
}
