#include "ripple_session.hpp"
#include "ripple_disk_io.hpp"

#include <libtorrent/session_params.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/magnet_uri.hpp>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/torrent_status.hpp>
#include <libtorrent/alert_types.hpp>
#include <libtorrent/read_resume_data.hpp>
#include <libtorrent/write_resume_data.hpp>
#include <libtorrent/hex.hpp>
#include <libtorrent/session_stats.hpp>

#include <emscripten/bind.h>

#include <sstream>
#include <vector>
#include <cstring>

using namespace libtorrent;
using emscripten::val;

namespace ripple {

namespace {

// Copy a typed JS Uint8Array into a std::vector<char>. Used for torrent files
// and saved state blobs.
std::vector<char> val_to_bytes(val const& v) {
  const unsigned n = v["length"].as<unsigned>();
  std::vector<char> out(n);
  val mem = val::module_property("HEAPU8");
  val sub = mem["buffer"];
  (void)sub;
  // Copy via JS: TypedArray.set on a temporary view is the fastest path from
  // JS to native without a second copy.
  val heap = val(emscripten::typed_memory_view(out.size(),
      reinterpret_cast<std::uint8_t*>(out.data())));
  heap.call<void>("set", v);
  return out;
}

val bytes_to_val(std::vector<char> const& bytes) {
  val u8 = val::global("Uint8Array").new_(val(bytes.size()));
  val heap = val(emscripten::typed_memory_view(bytes.size(),
      reinterpret_cast<const std::uint8_t*>(bytes.data())));
  u8.call<void>("set", heap);
  return u8;
}

std::string hex(info_hash_t const& h) {
  if (h.has_v2()) return aux::to_hex(h.v2);
  return aux::to_hex(h.v1);
}

} // namespace

Session::Session() {
  settings_pack sp;
  sp.set_int(settings_pack::alert_mask,
      alert_category::error
    | alert_category::status
    | alert_category::storage
    | alert_category::piece_progress
    | alert_category::stats
    | alert_category::dht);
  // Webvpn transport supports TCP and UDP through the @webvpn/* packages, so
  // we leave the default utp/tcp mix alone. Ripple's previous `utp: false`
  // existed because webtorrent's uTP path over @webvpn/dgram was unreliable;
  // libtorrent's uTP impl runs on the same dgram surface, so give it a try.
  sp.set_str(settings_pack::user_agent, "Ripple/0.1.0 libtorrent/" LIBTORRENT_VERSION);
  sp.set_bool(settings_pack::enable_dht, true);
  sp.set_bool(settings_pack::enable_lsd, false); // no multicast in browser
  sp.set_bool(settings_pack::enable_upnp, false);
  sp.set_bool(settings_pack::enable_natpmp, false);

  session_params params(sp);
  // Swap libtorrent's default disk I/O for our OPFS-delegating one.
  params.disk_io_constructor = ripple::ripple_disk_io_constructor;

  ses_ = std::make_unique<session>(std::move(params));
}

Session::~Session() {
  if (ses_) ses_->pause();
}

torrent_handle Session::find(std::string const& info_hash_hex) const {
  sha1_hash h;
  if (!aux::from_hex(info_hash_hex, h.data())) return {};
  return ses_->find_torrent(h);
}

std::string Session::add_torrent(val input, std::string storage_id) {
  add_torrent_params atp;
  atp.save_path = "/ripple/" + storage_id; // virtual path consumed by disk_io

  if (input.isString()) {
    error_code ec;
    atp = parse_magnet_uri(input.as<std::string>(), ec);
    if (ec) return {};
    atp.save_path = "/ripple/" + storage_id;
  } else {
    auto bytes = val_to_bytes(input);
    error_code ec;
    atp.ti = std::make_shared<torrent_info>(bytes.data(), int(bytes.size()), ec);
    if (ec) return {};
  }

  // Default every file to "do not download"; the TS engine explicitly
  // enables what the UI wants. Matches webtorrent's `deselect: true` mode.
  atp.file_priorities.assign(atp.ti ? atp.ti->num_files() : 0, download_priority::dont_download);

  torrent_handle th = ses_->add_torrent(std::move(atp));
  if (!th.is_valid()) return {};
  return hex(th.info_hashes());
}

void Session::remove_torrent(std::string info_hash, bool delete_files) {
  auto th = find(info_hash);
  if (!th.is_valid()) return;
  ses_->remove_torrent(th, delete_files ? session_handle::delete_files : remove_flags_t{});
}

void Session::set_file_priority(std::string info_hash, int file_index, int priority) {
  auto th = find(info_hash);
  if (!th.is_valid()) return;
  th.file_priority(file_index, download_priority_t(priority));
}

void Session::set_piece_deadline(std::string info_hash, int piece_index, int ms) {
  auto th = find(info_hash);
  if (!th.is_valid()) return;
  th.set_piece_deadline(piece_index_t(piece_index), ms, torrent_handle::alert_when_available);
}

val Session::pop_alerts() {
  std::vector<alert*> alerts;
  ses_->pop_alerts(&alerts);
  val out = val::array();
  int idx = 0;
  for (alert* a : alerts) {
    // ripple_alerts.cpp implements the translation table.
    extern val translate_alert(alert*);
    out.set(idx++, translate_alert(a));
  }
  return out;
}

val Session::session_stats() {
  val out = val::object();
  auto ss = ses_->status();
  out.set("downloadRate",     ss.download_rate);
  out.set("uploadRate",       ss.upload_rate);
  out.set("totalDownload",    double(ss.total_download));
  out.set("totalUpload",      double(ss.total_upload));
  out.set("dhtNodes",         ss.dht_nodes);
  out.set("numPeers",         ss.num_peers);
  return out;
}

val Session::torrent_status(std::string info_hash) {
  auto th = find(info_hash);
  val out = val::object();
  if (!th.is_valid()) return out;
  auto ts = th.status();
  out.set("infoHash",        info_hash);
  out.set("name",            ts.name);
  out.set("totalWanted",     double(ts.total_wanted));
  out.set("totalWantedDone", double(ts.total_wanted_done));
  out.set("downloadRate",    ts.download_payload_rate);
  out.set("uploadRate",      ts.upload_payload_rate);
  out.set("numPeers",        ts.num_peers);
  out.set("numSeeds",        ts.num_seeds);
  out.set("state",           int(ts.state));
  out.set("progress",        ts.progress);
  out.set("isPaused",        ts.flags & torrent_flags::paused ? true : false);
  return out;
}

val Session::read(std::string info_hash, int file_index,
                  std::int64_t offset, std::int64_t length) {
  // The actual read is serviced by the disk_interface. We translate (file,
  // offset, length) into piece-level requests and return a Promise. The JS
  // disk adapter is the one that settles it.
  extern val ripple_disk_read(std::string const& info_hash, int file_index,
                              std::int64_t offset, std::int64_t length);
  return ripple_disk_read(info_hash, file_index, offset, length);
}

void Session::pause()  { ses_->pause(); }
void Session::resume() { ses_->resume(); }

val Session::save_state() {
  entry e = ses_->session_state();
  std::vector<char> bytes;
  bencode(std::back_inserter(bytes), e);
  return bytes_to_val(bytes);
}

void Session::load_state(val bytes) {
  auto data = val_to_bytes(bytes);
  error_code ec;
  bdecode_node node = bdecode(data, ec);
  if (ec) return;
  ses_->load_state(node);
}

} // namespace ripple
