# native/ — libtorrent WebAssembly build

This directory builds `libtorrent.wasm` + JS glue from C++ sources. The output
is consumed by `src/engine/` as a normal ES module.

## What it produces

`build/libtorrent.js` and `build/libtorrent.wasm`, with:

- **libtorrent 2.x** compiled via Emscripten (pthreads enabled)
- **Boost** (headers + system + a few static libs) compiled for the
  `wasm32-unknown-emscripten` target
- A C++ wrapper (`src/ripple_*.cpp`) exposing a small embind surface that
  matches the TS engine's expectations
- A custom `disk_interface` implementation that forwards every read/write to
  JS callbacks (see `js/disk-library.js`), so storage is OPFS-backed
- A custom Emscripten socket library (see `js/socket-library.js`) that maps
  every socket syscall onto `@webvpn/net` and `@webvpn/dgram`

## Build (Docker, recommended)

    docker build -t ripple-native .
    docker run --rm -v "$PWD":/work -w /work ripple-native ./build.sh

The output lands in `native/build/`. The repo's `npm run build` (top-level)
copies those files into `build/` alongside the rest of the app.

## Build (local, without Docker)

You need: Emscripten 3.1.x or newer (`emcc --version`), CMake 3.20+, Python 3,
and a system Boost source tree. Then:

    EMSDK=/path/to/emsdk BOOST_ROOT=/path/to/boost ./build.sh

## What is not in here

- `@webvpn/net`, `@webvpn/dgram`, `@fkn/lib`: those stay normal npm deps and
  are imported by `src/engine/socket-webvpn.ts`. The C++ side never imports
  them; the socket JS library calls into JS-land where they're available.
- OPFS: the C++ disk_interface only emits async read/write requests; the JS
  side handles the actual `FileSystemSyncAccessHandle` calls.
- Threading: the build enables `-pthread`. The runtime needs cross-origin
  isolation (`COOP: same-origin`, `COEP: require-corp`) — see
  `vite.config.ts`.
