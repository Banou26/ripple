cmake_minimum_required(VERSION 3.20)
project(ripple_libtorrent CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "This project only builds under Emscripten. Run via build.sh.")
endif()

if(NOT DEFINED LIBTORRENT_ROOT)
  message(FATAL_ERROR "LIBTORRENT_ROOT is required")
endif()

set(deprecated-functions OFF CACHE BOOL "" FORCE)
set(build_examples OFF CACHE BOOL "" FORCE)
set(build_tests OFF CACHE BOOL "" FORCE)
set(build_tools OFF CACHE BOOL "" FORCE)
set(python-bindings OFF CACHE BOOL "" FORCE)

# Boost is built ahead of time by build.sh; libtorrent's CMake just needs
# headers + the system lib.
add_subdirectory(${LIBTORRENT_ROOT} ${CMAKE_CURRENT_BINARY_DIR}/libtorrent EXCLUDE_FROM_ALL)

add_executable(libtorrent
  src/ripple_session.cpp
  src/ripple_disk_io.cpp
  src/ripple_alerts.cpp
  src/ripple_bindings.cpp
)

target_link_libraries(libtorrent PRIVATE torrent-rasterbar)

target_compile_definitions(libtorrent PRIVATE
  TORRENT_USE_OPENSSL=0
  TORRENT_USE_LIBCRYPTO=0
  TORRENT_DISABLE_ENCRYPTION=0
  # We build single-threaded. libtorrent's default asio uses one
  # io_context and doesn't *need* worker threads — our disk_io_constructor
  # posts all jobs back onto the io_context, so the file-I/O thread pool
  # that libtorrent spins up by default is unused. If upstream libtorrent
  # instantiates a std::thread somewhere in a code path we hit, that's a
  # real porting task; patch it or guard with TORRENT_SINGLE_THREADED in a
  # downstream fork. For the MVP we rely on Asyncify + the fact that our
  # replaced disk/socket layers never cross thread boundaries.
)

# Emscripten link flags.
# - MODULARIZE: ES module factory (await default()).
# - EXPORT_ES6: ESM output, plays well with Vite.
# - ALLOW_MEMORY_GROWTH: torrents need elastic heap.
# - --bind: enable embind for C++ <-> JS.
# - --js-library: our socket + disk shim libraries.
# - ASYNCIFY: we don't use pthreads — every blocking JS call (socket recv,
#   disk read/write, getaddrinfo) suspends the single wasm thread via
#   Asyncify. COOP/COEP aren't required because there's no SharedArray
#   Buffer and no worker pool.
# - EXPORTED_RUNTIME_METHODS: exposed for the TS engine.
# - INITIAL_MEMORY: enough headroom for libtorrent + Boost statics.
target_link_options(libtorrent PRIVATE
  "SHELL:-s MODULARIZE=1"
  "SHELL:-s EXPORT_ES6=1"
  "SHELL:-s ALLOW_MEMORY_GROWTH=1"
  "SHELL:-s INITIAL_MEMORY=67108864"
  "SHELL:-s STACK_SIZE=1048576"
  "SHELL:-s ENVIRONMENT=worker,web"
  "SHELL:-s EXPORT_NAME=createLibtorrent"
  "SHELL:-s WASM_BIGINT=1"
  "SHELL:-s ASYNCIFY=1"
  "SHELL:-s ASYNCIFY_STACK_SIZE=65536"
  "SHELL:--bind"
  "SHELL:--js-library ${CMAKE_CURRENT_SOURCE_DIR}/js/socket-library.js"
  "SHELL:--js-library ${CMAKE_CURRENT_SOURCE_DIR}/js/disk-library.js"
  "SHELL:-s EXPORTED_RUNTIME_METHODS=['ccall','cwrap','HEAPU8','HEAPU32','UTF8ToString','stringToUTF8','lengthBytesUTF8']"
)

set_target_properties(libtorrent PROPERTIES
  OUTPUT_NAME "libtorrent"
  SUFFIX ".js"
)
