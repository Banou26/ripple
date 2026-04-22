#!/usr/bin/env bash
set -euo pipefail

# Build libtorrent.wasm + JS glue. Run inside the docker image from
# native/Dockerfile, or with EMSDK and BOOST_ROOT set on the host.

cd "$(dirname "$0")"

: "${EMSDK:?EMSDK must point to an emscripten install}"
: "${BOOST_ROOT:?BOOST_ROOT must point to a boost source tree}"
: "${LIBTORRENT_ROOT:=/opt/libtorrent}"

source "${EMSDK}/emsdk_env.sh" >/dev/null 2>&1 || true

BUILD_DIR="${PWD}/build"
B2_BUILD_DIR="${BUILD_DIR}/boost"
mkdir -p "${BUILD_DIR}" "${B2_BUILD_DIR}"

# 1. Boost: build only the libraries libtorrent links against, for the
#    emscripten target. Header-only parts are picked up via include path.
if [ ! -f "${B2_BUILD_DIR}/.stamp" ]; then
  pushd "${BOOST_ROOT}" >/dev/null
  ./bootstrap.sh --without-libraries=python
  cp "${PWD}/../boost-user-config.jam" 2>/dev/null tools/build/src/user-config.jam || \
    cp "$(dirname "$0")/boost-user-config.jam" tools/build/src/user-config.jam
  ./b2 \
    toolset=emscripten \
    link=static \
    threading=single \
    --with-system \
    --build-dir="${B2_BUILD_DIR}" \
    --stagedir="${B2_BUILD_DIR}/stage" \
    cxxflags="-std=c++17 -fPIC" \
    -j"$(nproc)"
  touch "${B2_BUILD_DIR}/.stamp"
  popd >/dev/null
fi

# 2. libtorrent + ripple wrapper: one CMake project, output is a single
#    .wasm + .js plus our two --js-library files merged in.
cmake -S . -B "${BUILD_DIR}/cmake" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="${EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBOOST_ROOT="${BOOST_ROOT}" \
  -DBoost_NO_SYSTEM_PATHS=ON \
  -DBoost_USE_STATIC_LIBS=ON \
  -DLIBTORRENT_ROOT="${LIBTORRENT_ROOT}" \
  -Ddeprecated-functions=OFF \
  -Dbuild_examples=OFF \
  -Dbuild_tests=OFF \
  -Dbuild_tools=OFF \
  -Dpython-bindings=OFF

cmake --build "${BUILD_DIR}/cmake" --parallel "$(nproc)"

# 3. Move outputs to a flat build/ for the top-level Vite copy step.
cp "${BUILD_DIR}/cmake/libtorrent.js"   "${BUILD_DIR}/libtorrent.js"
cp "${BUILD_DIR}/cmake/libtorrent.wasm" "${BUILD_DIR}/libtorrent.wasm"
cp "${BUILD_DIR}/cmake/libtorrent.worker.js" "${BUILD_DIR}/libtorrent.worker.js" 2>/dev/null || true

echo "OK: native/build/libtorrent.{js,wasm}"
