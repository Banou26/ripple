#!/usr/bin/env bash
set -euo pipefail

# Build torrent.wasm from the Go sources in this directory. Produces:
#   build/torrent.wasm    — the Go-compiled engine
#   build/wasm_exec.js    — the Go runtime glue (copied from GOROOT)

cd "$(dirname "$0")"
mkdir -p build

# Fetch dependencies the first time.
GOOS=js GOARCH=wasm go mod tidy

# Build. We pass -trimpath for reproducibility and -ldflags="-s -w" to strip
# the symbol table — anacrolix + its deps are large and the wasm binary
# benefits noticeably from stripping.
GOOS=js GOARCH=wasm go build \
  -trimpath \
  -ldflags="-s -w" \
  -o build/torrent.wasm .

# Copy the runtime shim. Location differs between upstream Go releases;
# try the known-good paths.
if [ -f "$(go env GOROOT)/lib/wasm/wasm_exec.js" ]; then
  cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" build/wasm_exec.js
elif [ -f "$(go env GOROOT)/misc/wasm/wasm_exec.js" ]; then
  cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" build/wasm_exec.js
else
  echo "wasm_exec.js not found under GOROOT=$(go env GOROOT)" >&2
  exit 1
fi

ls -lh build/torrent.wasm build/wasm_exec.js
echo "OK: native/build/torrent.{wasm,js}"
