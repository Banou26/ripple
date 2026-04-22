// Emscripten --js-library that overrides the BSD socket syscalls libtorrent
// emits. Every syscall is forwarded to globalThis.__ripple_sockets, which is
// installed by src/engine/socket-webvpn.ts and is backed by @webvpn/net
// (TCP) and @webvpn/dgram (UDP).
//
// The C++ side has no idea any of this exists; from libtorrent's POV it's
// calling into Emscripten's libc.
//
// Implementation strategy:
//   - We override the high-level posix calls Emscripten ships
//     (__sys_socket, __sys_bind, __sys_connect, __sys_sendto, __sys_recvfrom,
//      __sys_close, __sys_getsockopt, __sys_setsockopt, __sys_getpeername).
//   - All blocking calls are made async via Asyncify (`async: true` in the
//     library entry).
//   - We allocate fd numbers ourselves starting at 1024 to avoid colliding
//     with Emscripten's own fd table.

mergeInto(LibraryManager.library, {

  // ----- bookkeeping -----------------------------------------------------

  $RIPPLE_SOCK__deps: [],
  $RIPPLE_SOCK: {
    nextFd: 1024,
    sockets: new Map(),  // fd -> { kind: 'tcp'|'udp', handle, recvQueue, ... }
    api: function () {
      const a = globalThis.__ripple_sockets;
      if (!a) throw new Error('__ripple_sockets not registered on worker global');
      return a;
    },
    alloc: function (sock) {
      const fd = RIPPLE_SOCK.nextFd++;
      RIPPLE_SOCK.sockets.set(fd, sock);
      return fd;
    },
    free: function (fd) { RIPPLE_SOCK.sockets.delete(fd); },
    get: function (fd) { return RIPPLE_SOCK.sockets.get(fd); },

    // Marshal a sockaddr_in / sockaddr_in6 to {host, port}.
    readSockaddr: function (ptr, len) {
      const family = HEAPU16[ptr >> 1];
      if (family === 2 /* AF_INET */) {
        const port = (HEAPU8[ptr + 2] << 8) | HEAPU8[ptr + 3];
        const a = HEAPU8[ptr + 4], b = HEAPU8[ptr + 5];
        const c = HEAPU8[ptr + 6], d = HEAPU8[ptr + 7];
        return { host: a + '.' + b + '.' + c + '.' + d, port: port, family: 4 };
      }
      if (family === 10 /* AF_INET6 */) {
        const port = (HEAPU8[ptr + 2] << 8) | HEAPU8[ptr + 3];
        const parts = [];
        for (let i = 0; i < 8; i++) {
          const hi = HEAPU8[ptr + 8 + i * 2];
          const lo = HEAPU8[ptr + 8 + i * 2 + 1];
          parts.push(((hi << 8) | lo).toString(16));
        }
        return { host: parts.join(':'), port: port, family: 6 };
      }
      return { host: '', port: 0, family: family };
    },

    writeSockaddr: function (ptr, addr) {
      // Always emit AF_INET unless host has ':' — keeps libtorrent happy.
      const isV6 = addr.host.indexOf(':') !== -1;
      if (isV6) {
        HEAPU16[ptr >> 1] = 10;
        HEAPU8[ptr + 2] = (addr.port >> 8) & 0xff;
        HEAPU8[ptr + 3] = addr.port & 0xff;
        const parts = addr.host.split(':');
        for (let i = 0; i < 8; i++) {
          const v = parseInt(parts[i] || '0', 16);
          HEAPU8[ptr + 8 + i * 2] = (v >> 8) & 0xff;
          HEAPU8[ptr + 8 + i * 2 + 1] = v & 0xff;
        }
        return 28;
      } else {
        HEAPU16[ptr >> 1] = 2;
        HEAPU8[ptr + 2] = (addr.port >> 8) & 0xff;
        HEAPU8[ptr + 3] = addr.port & 0xff;
        const oct = addr.host.split('.').map(function (x) { return parseInt(x, 10) | 0; });
        HEAPU8[ptr + 4] = oct[0]; HEAPU8[ptr + 5] = oct[1];
        HEAPU8[ptr + 6] = oct[2]; HEAPU8[ptr + 7] = oct[3];
        return 16;
      }
    }
  },

  // ----- socket(2) -------------------------------------------------------

  __sys_socket__deps: ['$RIPPLE_SOCK'],
  __sys_socket: function (domain, type, protocol) {
    // type bits: SOCK_STREAM=1, SOCK_DGRAM=2 (Linux ABI). Strip flags.
    const baseType = type & 0xf;
    const kind = baseType === 1 ? 'tcp' : baseType === 2 ? 'udp' : null;
    if (!kind) return -22; // -EINVAL
    const sock = {
      kind: kind,
      handle: null,        // populated on connect/bind
      recvQueue: [],       // for udp: queued datagrams
      readable: null,      // for tcp: AsyncIterator over chunks
      writable: null,      // for tcp: write fn
      remote: null,        // for tcp: { host, port } after connect
      pending: Promise.resolve(),
      closed: false
    };
    return RIPPLE_SOCK.alloc(sock);
  },

  // ----- close(2) --------------------------------------------------------

  __sys_close__deps: ['$RIPPLE_SOCK'],
  __sys_close__async: true,
  __sys_close: function (fd) {
    const s = RIPPLE_SOCK.get(fd);
    if (!s) return 0; // not one of ours; leave it alone
    return Asyncify.handleAsync(async function () {
      try { if (s.handle && s.handle.close) await s.handle.close(); } catch (_) {}
      s.closed = true;
      RIPPLE_SOCK.free(fd);
      return 0;
    });
  },

  // ----- connect(2) (TCP) ------------------------------------------------

  __sys_connect__deps: ['$RIPPLE_SOCK'],
  __sys_connect__async: true,
  __sys_connect: function (fd, addrPtr, addrLen) {
    const s = RIPPLE_SOCK.get(fd);
    if (!s || s.kind !== 'tcp') return -88; // -ENOTSOCK
    const target = RIPPLE_SOCK.readSockaddr(addrPtr, addrLen);
    return Asyncify.handleAsync(async function () {
      try {
        const conn = await RIPPLE_SOCK.api().tcpConnect(target);
        s.handle   = conn;
        s.readable = conn.readable;     // ReadableStream<Uint8Array>
        s.writable = conn.writable;     // { write(u8), close() }
        s.remote   = target;
        return 0;
      } catch (e) {
        return -111; // -ECONNREFUSED
      }
    });
  },

  // ----- bind(2) (UDP only — TCP listen unsupported in browser) ----------

  __sys_bind__deps: ['$RIPPLE_SOCK'],
  __sys_bind__async: true,
  __sys_bind: function (fd, addrPtr, addrLen) {
    const s = RIPPLE_SOCK.get(fd);
    if (!s) return -88;
    if (s.kind !== 'udp') return -22; // tcp bind unsupported
    const local = RIPPLE_SOCK.readSockaddr(addrPtr, addrLen);
    return Asyncify.handleAsync(async function () {
      try {
        const sock = await RIPPLE_SOCK.api().udpBind(local);
        s.handle = sock;
        // Pump packets into the recv queue. libtorrent will drain them via
        // recvfrom calls.
        (async () => {
          try {
            for await (const pkt of sock.packets) {
              s.recvQueue.push(pkt);
              if (s.recvWaker) { const w = s.recvWaker; s.recvWaker = null; w(); }
            }
          } catch (_) {}
        })();
        return 0;
      } catch (_) { return -98; /* -EADDRINUSE */ }
    });
  },

  // ----- sendto(2) -------------------------------------------------------

  __sys_sendto__deps: ['$RIPPLE_SOCK'],
  __sys_sendto__async: true,
  __sys_sendto: function (fd, bufPtr, len, flags, addrPtr, addrLen) {
    const s = RIPPLE_SOCK.get(fd);
    if (!s || s.closed) return -32; // -EPIPE
    const data = HEAPU8.slice(bufPtr, bufPtr + len);
    return Asyncify.handleAsync(async function () {
      try {
        if (s.kind === 'tcp') {
          await s.writable.write(data);
          return len;
        } else {
          const dst = addrPtr ? RIPPLE_SOCK.readSockaddr(addrPtr, addrLen) : s.remote;
          await s.handle.send(data, dst);
          return len;
        }
      } catch (_) { return -32; }
    });
  },

  // ----- recvfrom(2) -----------------------------------------------------

  __sys_recvfrom__deps: ['$RIPPLE_SOCK'],
  __sys_recvfrom__async: true,
  __sys_recvfrom: function (fd, bufPtr, len, flags, addrPtr, addrLenPtr) {
    const s = RIPPLE_SOCK.get(fd);
    if (!s || s.closed) return 0;
    return Asyncify.handleAsync(async function () {
      if (s.kind === 'tcp') {
        // Lazily acquire a reader the first time.
        if (!s.reader) s.reader = s.readable.getReader();
        const { value, done } = await s.reader.read();
        if (done || !value) return 0;
        const n = Math.min(len, value.byteLength);
        HEAPU8.set(value.subarray(0, n), bufPtr);
        if (addrPtr && s.remote) RIPPLE_SOCK.writeSockaddr(addrPtr, s.remote);
        return n;
      } else {
        if (s.recvQueue.length === 0) {
          await new Promise(function (r) { s.recvWaker = r; });
          if (s.closed) return 0;
        }
        const pkt = s.recvQueue.shift();
        const n = Math.min(len, pkt.data.byteLength);
        HEAPU8.set(pkt.data.subarray(0, n), bufPtr);
        if (addrPtr) {
          const wrote = RIPPLE_SOCK.writeSockaddr(addrPtr, pkt.from);
          if (addrLenPtr) HEAPU32[addrLenPtr >> 2] = wrote;
        }
        return n;
      }
    });
  },

  // ----- getpeername(2) / getsockname(2) ---------------------------------

  __sys_getpeername__deps: ['$RIPPLE_SOCK'],
  __sys_getpeername: function (fd, addrPtr, addrLenPtr) {
    const s = RIPPLE_SOCK.get(fd);
    if (!s || !s.remote) return -107; // -ENOTCONN
    const wrote = RIPPLE_SOCK.writeSockaddr(addrPtr, s.remote);
    if (addrLenPtr) HEAPU32[addrLenPtr >> 2] = wrote;
    return 0;
  },

  // ----- getsockopt / setsockopt -----------------------------------------
  // libtorrent calls these for SO_REUSEADDR, TCP_NODELAY, etc. We accept and
  // ignore — the underlying transport doesn't expose these knobs.
  __sys_getsockopt: function () { return 0; },
  __sys_setsockopt: function () { return 0; },

  // ----- getaddrinfo -----------------------------------------------------
  // libtorrent resolves tracker hostnames via getaddrinfo. We forward to JS.
  __sys_getaddrinfo__deps: ['$RIPPLE_SOCK'],
  __sys_getaddrinfo__async: true,
  __sys_getaddrinfo: function (nodePtr, servPtr, hintsPtr, resPtr) {
    const host = UTF8ToString(nodePtr);
    const port = servPtr ? parseInt(UTF8ToString(servPtr), 10) || 0 : 0;
    return Asyncify.handleAsync(async function () {
      try {
        const addrs = await RIPPLE_SOCK.api().resolve(host);
        // For MVP: write the first result into a single addrinfo struct.
        // libtorrent only really cares about the first viable address.
        const sockaddrSize = 28;
        const aiSize = 32;
        const total = aiSize + sockaddrSize;
        const ptr = _malloc(total);
        const sa = ptr + aiSize;
        HEAPU32[ptr >> 2]            = 0;             // ai_flags
        HEAPU32[(ptr + 4) >> 2]      = 2;             // ai_family AF_INET
        HEAPU32[(ptr + 8) >> 2]      = 1;             // ai_socktype SOCK_STREAM
        HEAPU32[(ptr + 12) >> 2]     = 0;             // ai_protocol
        HEAPU32[(ptr + 16) >> 2]     = sockaddrSize;  // ai_addrlen
        HEAPU32[(ptr + 20) >> 2]     = sa;            // ai_addr
        HEAPU32[(ptr + 24) >> 2]     = 0;             // ai_canonname
        HEAPU32[(ptr + 28) >> 2]     = 0;             // ai_next
        RIPPLE_SOCK.writeSockaddr(sa, { host: addrs[0], port: port, family: 4 });
        HEAPU32[resPtr >> 2] = ptr;
        return 0;
      } catch (_) { return -2; /* -EAI_NONAME */ }
    });
  },

  __sys_freeaddrinfo: function (ptr) { if (ptr) _free(ptr); },
});
