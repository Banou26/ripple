// ripple_disk_io: a libtorrent disk_interface that forwards every read/write
// to JavaScript callbacks. The JS side stores chunks in OPFS, namespaced by
// torrent storage_id (one OPFS subdirectory per torrent).
//
// libtorrent 2.x's disk_interface is async — it submits jobs to a worker
// pool and signals completion via posted handlers. We model the same
// pattern: every async_* method posts the request to JS via Asyncify, then
// invokes the libtorrent-provided handler when JS resolves.

#pragma once

#include <libtorrent/disk_interface.hpp>
#include <libtorrent/io_context.hpp>
#include <libtorrent/counters.hpp>
#include <libtorrent/settings_pack.hpp>

#include <emscripten/val.h>
#include <memory>

namespace ripple {

// Constructor passed to libtorrent::session_params::disk_io_constructor.
std::unique_ptr<libtorrent::disk_interface>
ripple_disk_io_constructor(libtorrent::io_context& ios,
                           libtorrent::settings_interface const&,
                           libtorrent::counters& cnt);

// Bridge for Session::read — pulls bytes from libtorrent's piece cache
// (or triggers reads through the disk_interface) and returns a Promise that
// settles with a Uint8Array.
emscripten::val
ripple_disk_read(std::string const& info_hash, int file_index,
                 std::int64_t offset, std::int64_t length);

} // namespace ripple
