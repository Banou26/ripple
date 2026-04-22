// Embind surface — what the TS engine sees from `import createLibtorrent
// from '../../native/build/libtorrent.js'`.

#include "ripple_session.hpp"

#include <emscripten/bind.h>

EMSCRIPTEN_BINDINGS(ripple) {
  emscripten::class_<ripple::Session>("Session")
    .constructor<>()
    .function("addTorrent",        &ripple::Session::add_torrent)
    .function("removeTorrent",     &ripple::Session::remove_torrent)
    .function("setFilePriority",   &ripple::Session::set_file_priority)
    .function("setPieceDeadline",  &ripple::Session::set_piece_deadline)
    .function("popAlerts",         &ripple::Session::pop_alerts)
    .function("sessionStats",      &ripple::Session::session_stats)
    .function("torrentStatus",     &ripple::Session::torrent_status)
    .function("read",              &ripple::Session::read)
    .function("pause",             &ripple::Session::pause)
    .function("resume",            &ripple::Session::resume)
    .function("saveState",         &ripple::Session::save_state)
    .function("loadState",         &ripple::Session::load_state);
}
