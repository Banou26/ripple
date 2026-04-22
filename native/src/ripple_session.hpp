// ripple_session: thin wrapper around libtorrent::session that exposes a
// JS-friendly surface via embind. The wrapper owns the alert pump and
// translates libtorrent's event model into structured JS values that the TS
// engine consumes.

#pragma once

#include <memory>
#include <string>
#include <vector>
#include <cstdint>

#include <libtorrent/session.hpp>
#include <libtorrent/torrent_handle.hpp>
#include <libtorrent/info_hash.hpp>
#include <libtorrent/add_torrent_params.hpp>

#include <emscripten/val.h>

namespace ripple {

// Lifecycle: a single Session is created per app instance. The TS engine in
// the SharedWorker creates exactly one of these.
class Session {
public:
  Session();
  ~Session();

  Session(const Session&)            = delete;
  Session& operator=(const Session&) = delete;

  // Add a torrent.
  //   input: either a magnet URI string ("magnet:?xt=...") or the raw bytes
  //          of a .torrent file. The JS side decides which it is.
  //   storage_id: opaque handle the JS disk adapter uses to keep this
  //               torrent's chunks in their own OPFS subdirectory.
  // Returns the info-hash hex string on success, empty string on failure.
  std::string add_torrent(emscripten::val input, std::string storage_id);

  // Remove a torrent. delete_files removes the OPFS data too.
  void remove_torrent(std::string info_hash, bool delete_files);

  // File-level controls. file_index is the index into torrent.files.
  void set_file_priority(std::string info_hash, int file_index, int priority);
  void set_piece_deadline(std::string info_hash, int piece_index,
                          int milliseconds_from_now);

  // Pump pending alerts. Called repeatedly from JS (rAF-driven). Returns an
  // array of JS objects, one per alert, already translated into the shape
  // the TS engine expects.
  emscripten::val pop_alerts();

  // Snapshot of session-wide stats (downloaded/uploaded/dht nodes...).
  emscripten::val session_stats();

  // Snapshot of torrent status. Cheap; safe to poll.
  emscripten::val torrent_status(std::string info_hash);

  // Read raw bytes from a torrent file. Returns a Promise<Uint8Array> on the
  // JS side via embind val. Backed by libtorrent's piece cache + the
  // OPFS-backed disk_interface.
  emscripten::val read(std::string info_hash, int file_index,
                       std::int64_t offset, std::int64_t length);

  // Pause/resume DHT, LSD, etc. Wrappers over session::pause/resume.
  void pause();
  void resume();

  // Save and restore session state (DHT routing table, settings) as bytes.
  // Persisted by the JS engine into IndexedDB.
  emscripten::val save_state();
  void load_state(emscripten::val bytes);

private:
  std::unique_ptr<libtorrent::session> ses_;

  libtorrent::torrent_handle find(std::string const& info_hash) const;
};

} // namespace ripple
