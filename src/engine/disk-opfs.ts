// OPFS-backed storage. Contract consumed by native/storage_js.go:
//
//   __ripple_disk.open({ storage, files: [{index, path, length}] }) -> { ok }
//   __ripple_disk.close({ storage })                                 -> { ok }
//   __ripple_disk.delete({ storage })                                -> { ok }
//   __ripple_disk.read({ storage, fileIndex, offset, length })       -> { ok, bytes: Uint8Array }
//   __ripple_disk.write({ storage, fileIndex, offset, bytes })       -> { ok, written }
//
// Layout: one OPFS file per torrent file (not per piece). Pieces are
// translated to (fileIndex, offsetWithinFile) on the Go side. This matches
// how webtorrent lays out chunks on disk and makes streaming reads trivial
// — a `/watch` page can read directly from the OPFS file that corresponds
// to the torrent file it's playing.
//
// Each torrent gets its own OPFS subdirectory named by storage id. One
// FileSystemSyncAccessHandle per file, opened on first touch and closed
// when the torrent is released.

type DeclaredFile = { index: number, path: string, length: number }

type OpenReq   = { storage: string, files: DeclaredFile[] }
type CloseReq  = { storage: string }
type DeleteReq = { storage: string }
type ReadReq   = { storage: string, fileIndex: number, offset: number, length: number }
type WriteReq  = { storage: string, fileIndex: number, offset: number, bytes: Uint8Array }

type Ok      = { ok: true } | { ok: false, error: string }
type ReadRes = { ok: true, bytes: Uint8Array } | { ok: false, error: string }
type WriteRes = { ok: true, written: number } | { ok: false, error: string }

interface DiskApi {
  open   (req: OpenReq):   Promise<Ok>
  close  (req: CloseReq):  Promise<Ok>
  delete (req: DeleteReq): Promise<Ok>
  read   (req: ReadReq):   Promise<ReadRes>
  write  (req: WriteReq):  Promise<WriteRes>
}

class OpfsDisk implements DiskApi {
  private dirs    = new Map<string, FileSystemDirectoryHandle>()
  // storage -> fileIndex -> sync access handle
  private handles = new Map<string, Map<number, FileSystemSyncAccessHandle>>()
  // storage -> fileIndex -> declared metadata
  private metas   = new Map<string, Map<number, DeclaredFile>>()

  async open ({ storage, files }: OpenReq): Promise<Ok> {
    try {
      const root = await navigator.storage.getDirectory()
      const ns   = await root.getDirectoryHandle('ripple', { create: true })
      const dir  = await ns.getDirectoryHandle(storage, { create: true })
      this.dirs.set(storage, dir)
      this.handles.set(storage, new Map())
      const meta = new Map<number, DeclaredFile>()
      for (const f of files) meta.set(f.index, f)
      this.metas.set(storage, meta)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  async close ({ storage }: CloseReq): Promise<Ok> {
    const m = this.handles.get(storage)
    if (m) {
      for (const h of m.values()) try { h.close() } catch {}
      m.clear()
    }
    return { ok: true }
  }

  async delete ({ storage }: DeleteReq): Promise<Ok> {
    await this.close({ storage })
    try {
      const root = await navigator.storage.getDirectory()
      const ns   = await root.getDirectoryHandle('ripple', { create: true })
      await ns.removeEntry(storage, { recursive: true })
    } catch {}
    this.dirs.delete(storage)
    this.handles.delete(storage)
    this.metas.delete(storage)
    return { ok: true }
  }

  async read ({ storage, fileIndex, offset, length }: ReadReq): Promise<ReadRes> {
    try {
      const h = await this.handleFor(storage, fileIndex)
      const buf = new Uint8Array(length)
      const n = h.read(buf, { at: offset })
      return { ok: true, bytes: n === buf.byteLength ? buf : buf.subarray(0, n) }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  async write ({ storage, fileIndex, offset, bytes }: WriteReq): Promise<WriteRes> {
    try {
      const h = await this.handleFor(storage, fileIndex)
      const n = h.write(bytes, { at: offset })
      return { ok: true, written: n }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  private async handleFor (storage: string, fileIndex: number): Promise<FileSystemSyncAccessHandle> {
    const m = this.handles.get(storage)
    if (!m) throw new Error(`storage ${storage} not opened`)
    const cached = m.get(fileIndex)
    if (cached) return cached
    const dir = this.dirs.get(storage)!
    // Flatten any subdirectories in the torrent path into an underscore-
    // delimited filename to keep OPFS layout flat. We don't need to
    // preserve human-readable paths here — the UI already has the original
    // path in the FileInfo metadata.
    const meta = this.metas.get(storage)?.get(fileIndex)
    const safeName = `f${fileIndex}__${(meta?.path ?? '').replace(/[^A-Za-z0-9.-]+/g, '_')}`
    const file = await dir.getFileHandle(safeName, { create: true })
    const h = await (file as any).createSyncAccessHandle() as FileSystemSyncAccessHandle
    m.set(fileIndex, h)
    return h
  }
}

export const installOpfsDisk = () => {
  const api = new OpfsDisk()
  ;(globalThis as any).__ripple_disk = api
  return api
}

export type { DiskApi }
