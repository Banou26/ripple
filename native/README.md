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

## Threading model

The build is **single-threaded**. No `-pthread`, no SharedArrayBuffer, no
cross-origin isolation needed. Every blocking native call (socket recv,
disk read, getaddrinfo) is made from wasm via Asyncify: the wasm stack is
unwound, the JS promise is awaited, and the stack is rewound on resolve.

Caveat: libtorrent's upstream code spawns a disk worker thread
(`aux::disk_io_thread`) by default. We swap the entire `disk_io_constructor`
for our own (`ripple_disk_io_constructor`) so that thread is never created.
If a different libtorrent code path tries to instantiate a `std::thread`,
it won't work in this build — patch or replace the offending call site
(the most common culprits are tracker workers and hasher fan-out, both
already single-instance in asio-driven code paths).

Trade-off vs pthreads:
- Piece hashing runs on the main thread (inside Asyncify). Throughput is
  limited by SHA-1 on a single core — fine for video streaming, noticeable
  when seeding large libraries.
- No SharedArrayBuffer means `engine.read()` copies once when transferring
  bytes across the worker boundary. For 256 KB chunks the overhead is
  negligible vs the network latency.
