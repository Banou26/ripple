//go:build js && wasm

package main

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
	"github.com/anacrolix/torrent/storage"
)

// Engine owns the anacrolix torrent client and the set of currently-tracked
// torrents keyed by info-hash. It also owns the alert fan-out: every
// meaningful event in anacrolix (added, metadata ready, piece completed,
// etc.) is converted into the JSON-ish shape our TS engine expects.

type alertSink func(alert map[string]any)

type Engine struct {
	client *torrent.Client

	mu       sync.Mutex
	torrents map[string]*torrent.Torrent // infohash hex -> Torrent
	storages map[string]string           // infohash hex -> opaque storage id

	subsMu sync.Mutex
	subs   map[int]alertSink
	nextID int
}

func NewEngine() (*Engine, error) {
	cfg := torrent.NewDefaultClientConfig()

	// Storage: our custom OPFS-backed implementation (see storage_js.go).
	cfg.DefaultStorage = newJSStorage()

	// Networking. anacrolix's default NewClient tries to open OS sockets
	// for TCP/uTP listeners. In wasm none of that works — we have to
	// disable the builtin networks and inject our own dialer after the
	// client is constructed.
	cfg.DisableIPv6 = true
	cfg.DisableTCP = true  // we supply a custom TCP Dialer post-construction
	cfg.DisableUTP = true  // uTP needs a real PacketConn; we use UDP directly
	cfg.NoDHT = false
	cfg.Seed = true

	// HTTP-based trackers and webseed fetches reuse the same jsDialer.
	cfg.TrackerDialContext = (&jsDialer{}).DialContext
	cfg.HTTPDialContext    = (&jsDialer{}).DialContext

	// No inbound listeners — browsers can't accept incoming connections.
	cfg.NoDefaultPortForwarding = true
	cfg.DisableAcceptRateLimiting = true

	c, err := torrent.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("torrent.NewClient: %w", err)
	}

	// Inject our outbound TCP peer dialer. Every peer connection the
	// client attempts will go through @webvpn/net via jsDialer.
	c.AddDialer(torrent.NetworkDialer{Network: "tcp", Dialer: &jsDialer{}})

	// TODO(go-wasm): DHT + UDP tracker wiring. anacrolix's UDP side
	// normally reuses the same socket for utp peers and DHT. We've
	// disabled uTP, so DHT needs its own net.PacketConn:
	//
	//   pc, err := ListenUDP()       // already defined in net_js.go
	//   ds, err := c.NewAnacrolixDhtServer(pc)
	//
	// Left as a stub; HTTP trackers + TCP peers work without it.

	e := &Engine{
		client:   c,
		torrents: map[string]*torrent.Torrent{},
		storages: map[string]string{},
		subs:     map[int]alertSink{},
	}
	go e.pump()
	return e, nil
}

func (e *Engine) Subscribe(fn alertSink) (cancel func()) {
	e.subsMu.Lock()
	defer e.subsMu.Unlock()
	id := e.nextID
	e.nextID++
	e.subs[id] = fn
	return func() {
		e.subsMu.Lock()
		delete(e.subs, id)
		e.subsMu.Unlock()
	}
}

func (e *Engine) emit(alert map[string]any) {
	e.subsMu.Lock()
	fns := make([]alertSink, 0, len(e.subs))
	for _, fn := range e.subs {
		fns = append(fns, fn)
	}
	e.subsMu.Unlock()
	for _, fn := range fns {
		fn(alert)
	}
}

// pump emits state_update alerts at a fixed cadence and forwards per-torrent
// piece_finished events as they happen. anacrolix doesn't ship a uniform
// "alert system" like libtorrent — we stitch one together.
func (e *Engine) pump() {
	t := time.NewTicker(500 * time.Millisecond)
	defer t.Stop()
	for range t.C {
		e.mu.Lock()
		snaps := make([]map[string]any, 0, len(e.torrents))
		for ih, tor := range e.torrents {
			s := tor.Stats()
			info := tor.Info()
			var totalWanted, totalDone int64
			if info != nil {
				totalWanted = info.TotalLength()
			}
			totalDone = tor.BytesCompleted()
			snaps = append(snaps, map[string]any{
				"infoHash":        ih,
				"downloadRate":    s.BytesRead.Int64(), // bytes; UI renders as rate by sampling
				"uploadRate":      s.BytesWritten.Int64(),
				"numPeers":        s.ActivePeers,
				"totalWanted":     totalWanted,
				"totalWantedDone": totalDone,
				"progress":        progressOf(totalDone, totalWanted),
			})
		}
		e.mu.Unlock()
		if len(snaps) > 0 {
			e.emit(map[string]any{
				"type":     "state_update",
				"ts":       float64(time.Now().UnixMilli()),
				"torrents": snaps,
			})
		}
	}
}

func progressOf(done, wanted int64) float64 {
	if wanted <= 0 {
		return 0
	}
	return float64(done) / float64(wanted)
}

func (e *Engine) AddMagnet(uri, storageID string) (string, error) {
	tor, err := e.client.AddMagnet(uri)
	if err != nil {
		return "", fmt.Errorf("AddMagnet: %w", err)
	}
	return e.track(tor, storageID), nil
}

func (e *Engine) AddTorrentFile(b []byte, storageID string) (string, error) {
	mi, err := metainfo.Load(newByteReader(b))
	if err != nil {
		return "", fmt.Errorf("metainfo.Load: %w", err)
	}
	tor, err := e.client.AddTorrent(mi)
	if err != nil {
		return "", fmt.Errorf("AddTorrent: %w", err)
	}
	return e.track(tor, storageID), nil
}

func (e *Engine) track(t *torrent.Torrent, storageID string) string {
	ih := t.InfoHash().HexString()
	e.mu.Lock()
	e.torrents[ih] = t
	e.storages[ih] = storageID
	e.mu.Unlock()

	e.emit(map[string]any{
		"type":     "torrent_added",
		"ts":       float64(time.Now().UnixMilli()),
		"infoHash": ih,
	})

	// Metadata may already be here (for .torrent) or arrive later (magnet).
	go func() {
		<-t.GotInfo()
		info := t.Info()
		files := make([]map[string]any, 0, len(info.Files))
		if len(info.Files) == 0 {
			// Single-file torrent.
			files = append(files, map[string]any{
				"index":  0,
				"path":   info.Name,
				"length": info.Length,
			})
		} else {
			for i, f := range info.Files {
				files = append(files, map[string]any{
					"index":  i,
					"path":   f.DisplayPath(info),
					"length": f.Length,
				})
			}
		}
		e.emit(map[string]any{
			"type":     "metadata_received",
			"ts":       float64(time.Now().UnixMilli()),
			"infoHash": ih,
			"files":    files,
		})
	}()

	// Forward per-piece completion into alerts. anacrolix exposes a
	// subscription on Torrent.PieceStateChanges(); we watch for "complete".
	go func() {
		sub := t.SubscribePieceStateChanges()
		defer sub.Close()
		for ev := range sub.Values {
			if ev.PieceState.Complete {
				e.emit(map[string]any{
					"type":     "piece_finished",
					"ts":       float64(time.Now().UnixMilli()),
					"infoHash": ih,
					"piece":    ev.Index,
				})
			}
		}
	}()

	return ih
}

func (e *Engine) Remove(infoHash string, deleteFiles bool) error {
	e.mu.Lock()
	t, ok := e.torrents[infoHash]
	storageID := e.storages[infoHash]
	delete(e.torrents, infoHash)
	delete(e.storages, infoHash)
	e.mu.Unlock()
	if !ok {
		return errors.New("unknown torrent")
	}
	t.Drop()
	if deleteFiles && storageID != "" {
		if err := jsDiskDelete(storageID); err != nil {
			return fmt.Errorf("delete storage: %w", err)
		}
	}
	e.emit(map[string]any{
		"type":     "torrent_removed",
		"ts":       float64(time.Now().UnixMilli()),
		"infoHash": infoHash,
	})
	return nil
}

// SetFilePriority maps our 0..4 priority scale to anacrolix's PiecePriority.
// 0 disables the file, 4 forces it to the front of the picker.
func (e *Engine) SetFilePriority(infoHash string, fileIndex int, priority int) error {
	t, ok := e.get(infoHash)
	if !ok {
		return errors.New("unknown torrent")
	}
	files := t.Files()
	if fileIndex < 0 || fileIndex >= len(files) {
		return errors.New("file index out of range")
	}
	var p torrent.PiecePriority
	switch {
	case priority <= 0:
		p = torrent.PiecePriorityNone
	case priority == 1:
		p = torrent.PiecePriorityNormal
	case priority == 2:
		p = torrent.PiecePriorityHigh
	case priority == 3:
		p = torrent.PiecePriorityReadahead
	default:
		p = torrent.PiecePriorityNow
	}
	files[fileIndex].SetPriority(p)
	return nil
}

// SetReadahead biases the picker for streaming. It configures a Reader at
// the requested offset with a readahead window, which pushes the matching
// pieces to Now priority.
func (e *Engine) SetReadahead(infoHash string, fileIndex int, offset, bytes int64) error {
	t, ok := e.get(infoHash)
	if !ok {
		return errors.New("unknown torrent")
	}
	files := t.Files()
	if fileIndex < 0 || fileIndex >= len(files) {
		return errors.New("file index out of range")
	}
	r := files[fileIndex].NewReader()
	r.SetResponsive()
	r.SetReadahead(bytes)
	_, err := r.Seek(offset, 0)
	return err
}

// Read returns a contiguous byte range from a file. Blocks on pieces that
// aren't yet complete; anacrolix's Reader handles the wait internally.
func (e *Engine) Read(infoHash string, fileIndex int, offset, length int64) ([]byte, error) {
	t, ok := e.get(infoHash)
	if !ok {
		return nil, errors.New("unknown torrent")
	}
	files := t.Files()
	if fileIndex < 0 || fileIndex >= len(files) {
		return nil, errors.New("file index out of range")
	}
	r := files[fileIndex].NewReader()
	r.SetResponsive()
	r.SetReadahead(length * 2)
	defer r.Close()

	if _, err := r.Seek(offset, 0); err != nil {
		return nil, err
	}
	buf := make([]byte, length)
	total := 0
	for total < len(buf) {
		n, err := r.Read(buf[total:])
		total += n
		if err != nil {
			if total == len(buf) {
				break
			}
			return nil, err
		}
	}
	return buf[:total], nil
}

func (e *Engine) Status(infoHash string) (map[string]any, error) {
	t, ok := e.get(infoHash)
	if !ok {
		return nil, errors.New("unknown torrent")
	}
	s := t.Stats()
	info := t.Info()
	var totalWanted int64
	var name string
	if info != nil {
		totalWanted = info.TotalLength()
		name = info.Name
	}
	return map[string]any{
		"infoHash":        infoHash,
		"name":            name,
		"totalWanted":     totalWanted,
		"totalWantedDone": t.BytesCompleted(),
		"downloadRate":    s.BytesRead.Int64(),
		"uploadRate":      s.BytesWritten.Int64(),
		"numPeers":        s.ActivePeers,
		"numSeeds":        s.ConnectedSeeders,
		"state":           0,
		"progress":        progressOf(t.BytesCompleted(), totalWanted),
		"isPaused":        false,
	}, nil
}

func (e *Engine) List() []map[string]any {
	e.mu.Lock()
	ihs := make([]string, 0, len(e.torrents))
	for ih := range e.torrents {
		ihs = append(ihs, ih)
	}
	e.mu.Unlock()

	out := make([]map[string]any, 0, len(ihs))
	for _, ih := range ihs {
		t, ok := e.get(ih)
		if !ok {
			continue
		}
		info := t.Info()
		files := []map[string]any{}
		if info != nil {
			if len(info.Files) == 0 {
				files = append(files, map[string]any{"index": 0, "path": info.Name, "length": info.Length})
			} else {
				for i, f := range info.Files {
					files = append(files, map[string]any{"index": i, "path": f.DisplayPath(info), "length": f.Length})
				}
			}
		}
		status, _ := e.Status(ih)
		out = append(out, map[string]any{
			"infoHash": ih,
			"files":    files,
			"status":   status,
		})
	}
	return out
}

func (e *Engine) Pause() {
	// anacrolix doesn't expose a global pause; approximate by disallowing
	// all data connections.
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, t := range e.torrents {
		t.DisallowDataDownload()
		t.DisallowDataUpload()
	}
}

func (e *Engine) Resume() {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, t := range e.torrents {
		t.AllowDataDownload()
		t.AllowDataUpload()
	}
}

// SaveState / LoadState: anacrolix doesn't have a built-in serialization of
// session state (DHT routing table, peer db). For a first cut we persist
// just the set of info-hashes and their magnet links; the IndexedDB store
// on the JS side already holds those, so these are no-ops here. Left as a
// stub so the JS API surface stays stable.
func (e *Engine) SaveState() []byte { return nil }
func (e *Engine) LoadState([]byte)  {}

func (e *Engine) get(infoHash string) (*torrent.Torrent, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	t, ok := e.torrents[infoHash]
	return t, ok
}

// Silence unused-import warnings when some of the storage package types
// aren't referenced directly (they still need to be in the module graph
// for anacrolix's default client config wiring).
var _ storage.ClientImpl = (storage.ClientImpl)(nil)

// byteReader wraps a []byte as an io.Reader so metainfo.Load can parse
// torrent files from memory without touching the filesystem.
type byteReader struct {
	b   []byte
	pos int
}

func newByteReader(b []byte) *byteReader { return &byteReader{b: b} }

func (r *byteReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.b) {
		return 0, errEOF
	}
	n := copy(p, r.b[r.pos:])
	r.pos += n
	return n, nil
}

var errEOF = errors.New("EOF")
