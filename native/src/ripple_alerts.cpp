// Translates libtorrent alerts into plain JS objects. Keep the shape stable
// because the TS engine destructures these in `alerts.ts`.

#include <libtorrent/alert.hpp>
#include <libtorrent/alert_types.hpp>
#include <libtorrent/hex.hpp>
#include <libtorrent/torrent_status.hpp>
#include <emscripten/val.h>

#include <string>

using namespace libtorrent;
using emscripten::val;

namespace ripple {

namespace {

std::string ihex(torrent_handle const& th) {
  if (!th.is_valid()) return {};
  auto ih = th.info_hashes();
  if (ih.has_v2()) return aux::to_hex(ih.v2);
  return aux::to_hex(ih.v1);
}

val base(alert* a, char const* type) {
  val o = val::object();
  o.set("type", std::string(type));
  o.set("ts", double(a->timestamp().time_since_epoch().count()));
  return o;
}

} // namespace

val translate_alert(alert* a) {
  switch (a->type()) {

    case torrent_added_alert::alert_type: {
      auto* ev = static_cast<torrent_added_alert*>(a);
      val o = base(a, "torrent_added");
      o.set("infoHash", ihex(ev->handle));
      return o;
    }

    case torrent_removed_alert::alert_type: {
      auto* ev = static_cast<torrent_removed_alert*>(a);
      val o = base(a, "torrent_removed");
      o.set("infoHash", ihex(ev->handle));
      return o;
    }

    case metadata_received_alert::alert_type: {
      auto* ev = static_cast<metadata_received_alert*>(a);
      val o = base(a, "metadata_received");
      o.set("infoHash", ihex(ev->handle));
      // Files list — the UI needs this to render the file picker as soon as
      // metadata arrives, well before pieces start landing.
      val files = val::array();
      auto ti = ev->handle.torrent_file();
      if (ti) {
        auto& fs = ti->files();
        for (file_index_t i{0}; i < fs.end_file(); ++i) {
          val f = val::object();
          f.set("index",  int(static_cast<int>(i)));
          f.set("path",   fs.file_path(i));
          f.set("length", double(fs.file_size(i)));
          files.set(int(static_cast<int>(i)), f);
        }
      }
      o.set("files", files);
      return o;
    }

    case torrent_finished_alert::alert_type: {
      auto* ev = static_cast<torrent_finished_alert*>(a);
      val o = base(a, "torrent_finished");
      o.set("infoHash", ihex(ev->handle));
      return o;
    }

    case piece_finished_alert::alert_type: {
      auto* ev = static_cast<piece_finished_alert*>(a);
      val o = base(a, "piece_finished");
      o.set("infoHash", ihex(ev->handle));
      o.set("piece",    int(static_cast<int>(ev->piece_index)));
      return o;
    }

    case state_update_alert::alert_type: {
      auto* ev = static_cast<state_update_alert*>(a);
      val o = base(a, "state_update");
      val arr = val::array();
      int i = 0;
      for (auto const& ts : ev->status) {
        val t = val::object();
        t.set("infoHash",        ihex(ts.handle));
        t.set("downloadRate",    ts.download_payload_rate);
        t.set("uploadRate",      ts.upload_payload_rate);
        t.set("numPeers",        ts.num_peers);
        t.set("totalWanted",     double(ts.total_wanted));
        t.set("totalWantedDone", double(ts.total_wanted_done));
        t.set("progress",        ts.progress);
        arr.set(i++, t);
      }
      o.set("torrents", arr);
      return o;
    }

    case read_piece_alert::alert_type: {
      auto* ev = static_cast<read_piece_alert*>(a);
      val o = base(a, "read_piece");
      o.set("infoHash", ihex(ev->handle));
      o.set("piece",    int(static_cast<int>(ev->piece)));
      // Caller pulls the actual buffer via Session::read; we don't ship it
      // through the alert pump because alerts are JSON-shaped.
      return o;
    }

    default: {
      val o = base(a, a->what());
      o.set("message", a->message());
      return o;
    }
  }
}

} // namespace ripple
