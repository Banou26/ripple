# Reproducible toolchain for building torrent.wasm from Go sources.

FROM golang:1.22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work
