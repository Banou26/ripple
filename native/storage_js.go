//go:build js && wasm

package main

import (
	"context"
	"errors"
	"sync"
	"syscall/js"

	"github.com/anacrolix/torrent/metainfo"
	"github.com/anacrolix/torrent/storage"
)

// OPFS-backed storage. Each torrent lives in its own OPFS subdirectory
// (see src/engine/disk-opfs.ts). We store one OPFS file per torrent file
// — not per piece — because torrent files are the natural streaming unit
// and because a typical anime/movie has a handful of files vs. thousands
// of pieces.
//
// anacrolix asks us for piece-aligned reads/writes against a TorrentImpl,
// but exposes metainfo.Info so we can map (piece index, offset within
// piece) back to (file index, offset within file). We do that translation
// here once per write/read.

// The JS contract (src/engine/disk-opfs.ts):
//
//   __ripple_disk.open({storage, files: [{index, path, length}]}) -> {ok}
//   __ripple_disk.close({storage}) -> {ok}
//   __ripple_disk.delete({storage}) -> {ok}
//   __ripple_disk.read({storage, fileIndex, offset, length}) -> {ok, bytes}
//   __ripple_disk.write({storage, fileIndex, offset, bytes}) -> {ok, written}

func getDiskAPI() js.Value {
	api := js.Global().Get("__ripple_disk")
	if api.Type() == js.TypeUndefined {
		panic("globalThis.__ripple_disk is not installed")
	}
	return api
}

func jsDiskDelete(storageID string) error {
	arg := js.Global().Get("Object").New()
	arg.Set("storage", storageID)
	_, err := await(getDiskAPI().Call("delete", arg))
	return err
}

type jsStorage struct {
	mu       sync.Mutex
	torrents map[metainfo.Hash]*jsStorageTorrent
}

func newJSStorage() *jsStorage {
	return &jsStorage{torrents: map[metainfo.Hash]*jsStorageTorrent{}}
}

func (s *jsStorage) OpenTorrent(_ context.Context, info *metainfo.Info, infoHash metainfo.Hash) (storage.TorrentImpl, error) {
	storageID := infoHash.HexString()

	filesJS := js.Global().Get("Array").New()
	if len(info.Files) == 0 {
		f := js.Global().Get("Object").New()
		f.Set("index", 0)
		f.Set("path", info.Name)
		f.Set("length", float64(info.Length))
		filesJS.SetIndex(0, f)
	} else {
		for i, f := range info.Files {
			jf := js.Global().Get("Object").New()
			jf.Set("index", i)
			jf.Set("path", f.DisplayPath(info))
			jf.Set("length", float64(f.Length))
			filesJS.SetIndex(i, jf)
		}
	}
	arg := js.Global().Get("Object").New()
	arg.Set("storage", storageID)
	arg.Set("files", filesJS)
	if _, err := await(getDiskAPI().Call("open", arg)); err != nil {
		return storage.TorrentImpl{}, err
	}

	t := &jsStorageTorrent{
		storageID: storageID,
		info:      info,
	}
	s.mu.Lock()
	s.torrents[infoHash] = t
	s.mu.Unlock()

	return storage.TorrentImpl{
		Piece: func(p metainfo.Piece) storage.PieceImpl { return &jsPiece{t: t, p: p} },
		Close: t.close,
	}, nil
}

func (s *jsStorage) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var firstErr error
	for _, t := range s.torrents {
		if err := t.close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	s.torrents = map[metainfo.Hash]*jsStorageTorrent{}
	return firstErr
}

type jsStorageTorrent struct {
	storageID string
	info      *metainfo.Info
	completed sync.Map // piece index -> true when verified
}

func (t *jsStorageTorrent) close() error {
	arg := js.Global().Get("Object").New()
	arg.Set("storage", t.storageID)
	_, err := await(getDiskAPI().Call("close", arg))
	return err
}

// jsPiece is the per-piece view anacrolix uses for I/O. A piece's bytes
// may span multiple torrent files, so ReadAt/WriteAt translate the piece-
// relative offset into (file, offset-in-file) tuples and stream through.
type jsPiece struct {
	t *jsStorageTorrent
	p metainfo.Piece
}

func (jp *jsPiece) Completion() storage.Completion {
	_, ok := jp.t.completed.Load(int(jp.p.Index()))
	return storage.Completion{Ok: true, Complete: ok}
}

func (jp *jsPiece) MarkComplete() error {
	jp.t.completed.Store(int(jp.p.Index()), true)
	return nil
}

func (jp *jsPiece) MarkNotComplete() error {
	jp.t.completed.Delete(int(jp.p.Index()))
	return nil
}

func (jp *jsPiece) ReadAt(buf []byte, off int64) (int, error) {
	abs := jp.p.Offset() + off
	return readAcrossFiles(jp.t, buf, abs)
}

func (jp *jsPiece) WriteAt(buf []byte, off int64) (int, error) {
	abs := jp.p.Offset() + off
	return writeAcrossFiles(jp.t, buf, abs)
}

// readAcrossFiles / writeAcrossFiles: resolve an absolute byte offset
// within the torrent into (file index, offset within file), then issue one
// JS call per file segment the buffer spans. Most pieces land in a single
// file; the cross-file case is only the rare "end of file" boundary.

type fileSegment struct {
	index  int
	offset int64
	length int
}

func segmentsFor(info *metainfo.Info, abs int64, size int) []fileSegment {
	var out []fileSegment
	if len(info.Files) == 0 {
		return []fileSegment{{index: 0, offset: abs, length: size}}
	}
	var running int64
	remaining := size
	for i, f := range info.Files {
		start := running
		end := running + f.Length
		running = end
		if abs >= end {
			continue
		}
		if int64(remaining) == 0 {
			break
		}
		segOff := abs - start
		if segOff < 0 {
			segOff = 0
		}
		segLen := int(end - (start + segOff))
		if segLen > remaining {
			segLen = remaining
		}
		out = append(out, fileSegment{index: i, offset: segOff, length: segLen})
		abs += int64(segLen)
		remaining -= segLen
	}
	return out
}

func readAcrossFiles(t *jsStorageTorrent, buf []byte, abs int64) (int, error) {
	segs := segmentsFor(t.info, abs, len(buf))
	pos := 0
	for _, seg := range segs {
		arg := js.Global().Get("Object").New()
		arg.Set("storage", t.storageID)
		arg.Set("fileIndex", seg.index)
		arg.Set("offset", float64(seg.offset))
		arg.Set("length", seg.length)
		res, err := await(getDiskAPI().Call("read", arg))
		if err != nil {
			return pos, err
		}
		if !res.Get("ok").Bool() {
			return pos, errors.New(res.Get("error").String())
		}
		bytes := res.Get("bytes")
		n := bytes.Get("byteLength").Int()
		js.CopyBytesToGo(buf[pos:pos+n], bytes)
		pos += n
		if n < seg.length {
			return pos, nil
		}
	}
	return pos, nil
}

func writeAcrossFiles(t *jsStorageTorrent, buf []byte, abs int64) (int, error) {
	segs := segmentsFor(t.info, abs, len(buf))
	pos := 0
	for _, seg := range segs {
		chunk := buf[pos : pos+seg.length]
		arg := js.Global().Get("Object").New()
		arg.Set("storage", t.storageID)
		arg.Set("fileIndex", seg.index)
		arg.Set("offset", float64(seg.offset))
		arg.Set("bytes", bytesToUint8Array(chunk))
		res, err := await(getDiskAPI().Call("write", arg))
		if err != nil {
			return pos, err
		}
		if !res.Get("ok").Bool() {
			return pos, errors.New(res.Get("error").String())
		}
		pos += seg.length
	}
	return pos, nil
}
