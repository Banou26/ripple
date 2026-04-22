# Reproducible toolchain for building libtorrent.wasm.
#
# Pinned versions so the output is deterministic across machines.

FROM emscripten/emsdk:3.1.64

ARG BOOST_VERSION=1.84.0
ARG BOOST_VERSION_UNDERSCORE=1_84_0
ARG LIBTORRENT_VERSION=2.0.10

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      cmake ninja-build python3 ca-certificates wget xz-utils git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

RUN wget -q "https://archives.boost.io/release/${BOOST_VERSION}/source/boost_${BOOST_VERSION_UNDERSCORE}.tar.bz2" \
 && tar xf "boost_${BOOST_VERSION_UNDERSCORE}.tar.bz2" \
 && rm "boost_${BOOST_VERSION_UNDERSCORE}.tar.bz2" \
 && mv "boost_${BOOST_VERSION_UNDERSCORE}" boost

RUN git clone --depth 1 --branch "v${LIBTORRENT_VERSION}" --recurse-submodules \
      https://github.com/arvidn/libtorrent.git /opt/libtorrent

ENV BOOST_ROOT=/opt/boost
ENV LIBTORRENT_ROOT=/opt/libtorrent
ENV EMSDK=/emsdk

WORKDIR /work
