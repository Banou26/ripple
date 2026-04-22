// OPFS disk adapter. Installed on the worker global as `__ripple_disk` so
// the C++ disk_interface (via EM_ASYNC_JS in ripple_disk_io.cpp) can call
// into it.
//
// One OPFS subdirectory per torrent, keyed by storageId (usually the
// info-hash). One sync access handle per (storage, piece) pair while open.
// Sync access handles are required so we can do positioned reads/writes
// without juggling FileSystemWritableFileStream offsets.

type Json = string | number | boolean | null | { [k: string]: Json } | Json[]

type OpenReq   = { storage: string }
type CloseReq  = { storage: string }
type DeleteReq = { storage: string }
type RenameReq = { storage: string, index: number, newName: string }
type ReadReq   = { storage: string, piece: number, offset: number, length: number }
type WriteReq  = { storage: string, piece: number, offset: number, length: number }
type HashReq   = { storage: string, piece: number }

type OpenRes  = { ok: true } | { ok: false, error: string }
type ReadRes  = { ok: true, ptr: number, length: number } | { ok: false, error: string }
type WriteRes = { ok: true, written: number } | { ok: false, error: string }
type HashRes  = { hex: string }

interface DiskApi {
  open(req: OpenReq):     Promise<OpenRes>
  close(req: CloseReq):   Promise<OpenRes>
  delete(req: DeleteReq): Promise<OpenRes>
  rename(req: RenameReq): Promise<OpenRes>
  read(req: ReadReq):     Promise<ReadRes>
  write(req: WriteReq):   Promise<WriteRes>
  hash(req: HashReq):     Promise<HashRes>
}

class OpfsDisk implements DiskApi {
  // storage -> directory
  private dirs = new Map<string, FileSystemDirectoryHandle>()
  // storage -> piece -> sync handle (open lazily, closed on releaseFiles)
  private handles = new Map<string, Map<number, FileSystemSyncAccessHandle>>()

  async open({ storage }: OpenReq): Promise<OpenRes> {
    const root = await navigator.storage.getDirectory()
    const ns = await root.getDirectoryHandle('ripple', { create: true })
    const dir = await ns.getDirectoryHandle(storage, { create: true })
    this.dirs.set(storage, dir)
    this.handles.set(storage, new Map())
    return { ok: true }
  }

  async close({ storage }: CloseReq): Promise<OpenRes> {
    const m = this.handles.get(storage)
    if (m) {
      for (const h of m.values()) try { h.close() } catch {}
      m.clear()
    }
    return { ok: true }
  }

  async delete({ storage }: DeleteReq): Promise<OpenRes> {
    await this.close({ storage })
    const root = await navigator.storage.getDirectory()
    const ns = await root.getDirectoryHandle('ripple', { create: true })
    try { await ns.removeEntry(storage, { recursive: true }) } catch {}
    this.dirs.delete(storage)
    this.handles.delete(storage)
    return { ok: true }
  }

  async rename(_: RenameReq): Promise<OpenRes> {
    // Pieces are indexed by piece number, not file path; renames are a
    // metadata-only concern handled by the engine's torrent_info copy. The
    // disk layer doesn't need to do anything.
    return { ok: true }
  }

  private async handleFor(storage: string, piece: number): Promise<FileSystemSyncAccessHandle> {
    const m = this.handles.get(storage)
    if (!m) throw new Error(`storage ${storage} not opened`)
    const cached = m.get(piece)
    if (cached) return cached
    const dir = this.dirs.get(storage)!
    const file = await dir.getFileHandle(`p${piece}`, { create: true })
    const h = await (file as any).createSyncAccessHandle()
    m.set(piece, h)
    return h
  }

  async read({ storage, piece, offset, length }: ReadReq): Promise<ReadRes> {
    try {
      const h = await this.handleFor(storage, piece)
      const ptr = (globalThis as any)._malloc(length) as number
      const view = new Uint8Array((globalThis as any).HEAPU8.buffer, ptr, length)
      const n = h.read(view, { at: offset })
      return { ok: true, ptr, length: n }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  async write({ storage, piece, offset, length }: WriteReq): Promise<WriteRes> {
    // The C++ side is expected to pass payload via a separate pointer arg
    // in a follow-up implementation; for now this is a no-op skeleton that
    // returns success so libtorrent's pipeline doesn't stall during a dry
    // boot. TODO: wire payload pointer through ripple_disk_call.
    void storage; void piece; void offset
    return { ok: true, written: length }
  }

  async hash({ storage, piece }: HashReq): Promise<HashRes> {
    const h = await this.handleFor(storage, piece)
    const size = h.getSize()
    const buf = new Uint8Array(size)
    h.read(buf, { at: 0 })
    const digest = await crypto.subtle.digest('SHA-1', buf)
    const hex = Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    return { hex }
  }
}

export const installOpfsDisk = () => {
  const api = new OpfsDisk()
  ;(globalThis as any).__ripple_disk = api
  return api
}

export type { DiskApi }
