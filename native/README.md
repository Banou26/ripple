# native/ — anacrolix/torrent WebAssembly build

This directory builds `torrent.wasm` + the Go runtime glue (`wasm_exec.js`)
from Go sources that embed [anacrolix/torrent]. The output is consumed by
`src/engine/` as an opaque wasm module.

## What it produces

- `build/torrent.wasm` — Go-compiled bittorrent engine (anacrolix/torrent +
  a thin API wrapper exposing our TS engine's expected surface)
- `build/wasm_exec.js` — Go's standard wasm runtime glue, copied from the
  Go toolchain

## Why Go / anacrolix

- `js/wasm` is a first-class build target for `anacrolix/torrent` — the
  main package, its storage backends, and its DHT all compile cleanly for
  browsers. No cgo dependencies to wrestle with.
- Go's WASM runtime multiplexes all goroutines onto a single thread, which
  matches our "no pthreads, no SharedArrayBuffer" constraint exactly. No
  COOP/COEP needed at the site level.
- Single-file output: one `.wasm` + one small JS shim, loaded from a
  SharedWorker.

## Build (Docker, recommended)

    docker build -t ripple-native .
    docker run --rm -v "$PWD":/work -w /work ripple-native ./build.sh

The output lands in `native/build/`. The repo's `npm run build` copies it
into the app's `build/` tree.

## Build (local)

Requires Go 1.22+.

    ./build.sh

## Runtime contract

The wasm module installs a namespace on `globalThis.__ripple` with the
following methods (all async, returning JS Promises):

- `addTorrent(input, storageId)` — `input` is a magnet string or Uint8Array
  (.torrent bytes). Returns the info-hash hex.
- `removeTorrent(infoHash, deleteFiles)`
- `setFilePriority(infoHash, fileIndex, priority)` — priority: 0=none, 1..4
- `setReadahead(infoHash, fileIndex, bytes)` — biases the picker for the
  currently-playing byte range.
- `list()` — full snapshot.
- `status(infoHash)`
- `read(infoHash, fileIndex, offset, length)` — streaming read, awaits
  pieces as needed.
- `subscribe(callback)` — returns an unsubscribe function. Alerts arrive
  as plain JS objects matching `src/engine/alerts.ts`.
- `pause()`, `resume()`, `saveState()`, `loadState(bytes)`.

It depends on two JS surfaces that `src/engine/` installs before the wasm
boots:

- `globalThis.__ripple_sockets` — TCP dialer + UDP bind; see
  `src/engine/socket-webvpn.ts`.
- `globalThis.__ripple_disk` — OPFS-backed storage; see
  `src/engine/disk-opfs.ts`.
