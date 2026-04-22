// Bridge between the Emscripten socket library (native/js/socket-library.js)
// and @webvpn/net + @webvpn/dgram. Installed on globalThis.__ripple_sockets.
//
// The contract the JS library relies on:
//
//   tcpConnect({ host, port }) -> Promise<{
//     readable: ReadableStream<Uint8Array>,
//     writable: { write(Uint8Array): Promise<void>, close(): Promise<void> },
//     close(): Promise<void>
//   }>
//
//   udpBind({ host, port }) -> Promise<{
//     send(data: Uint8Array, dst: { host, port }): Promise<void>,
//     packets: AsyncIterable<{ data: Uint8Array, from: { host, port } }>,
//     close(): Promise<void>
//   }>
//
//   resolve(host) -> Promise<string[]>  // dotted-quad strings
//
// @webvpn/net's API surface is Node-net-shaped (createConnection returning a
// Duplex-like). We adapt it to ReadableStream/AsyncIterable here so the JS
// library doesn't need to know about Node streams.

// @ts-ignore — package ships no types
import * as webvpnNet from '@webvpn/net'
// @ts-ignore — same
import * as webvpnDgram from '@webvpn/dgram'

type Addr = { host: string, port: number, family?: number }

const tcpConnect = async (target: Addr) => {
  const sock = webvpnNet.createConnection({ host: target.host, port: target.port })
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve())
    sock.once('error', reject)
  })

  let pull: ((value: Uint8Array | null) => void) | null = null
  const queue: Uint8Array[] = []
  sock.on('data', (chunk: Uint8Array) => {
    const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (pull) { const p = pull; pull = null; p(u8) } else queue.push(u8)
  })
  sock.on('end', () => { if (pull) { const p = pull; pull = null; p(null) } })

  const readable = new ReadableStream<Uint8Array>({
    pull (controller) {
      if (queue.length) { controller.enqueue(queue.shift()!); return }
      return new Promise<void>(resolve => {
        pull = (v) => {
          if (v === null) controller.close()
          else controller.enqueue(v)
          resolve()
        }
      })
    },
    cancel () { try { sock.destroy() } catch {} }
  })

  return {
    readable,
    writable: {
      write: (data: Uint8Array) => new Promise<void>((resolve, reject) => {
        sock.write(data, (err: Error | null) => err ? reject(err) : resolve())
      }),
      close: () => new Promise<void>(resolve => { sock.end(() => resolve()) })
    },
    close: () => new Promise<void>(resolve => { sock.end(() => resolve()) })
  }
}

const udpBind = async (local: Addr) => {
  const sock = webvpnDgram.createSocket('udp4')
  await new Promise<void>((resolve, reject) => {
    sock.bind(local.port, local.host, () => resolve())
    sock.once('error', reject)
  })

  const queue: { data: Uint8Array, from: Addr }[] = []
  let waiter: ((v: IteratorResult<{ data: Uint8Array, from: Addr }>) => void) | null = null
  let closed = false

  sock.on('message', (msg: Uint8Array, rinfo: { address: string, port: number }) => {
    const u8 = new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength)
    const item = { data: u8, from: { host: rinfo.address, port: rinfo.port } }
    if (waiter) { const w = waiter; waiter = null; w({ value: item, done: false }) }
    else queue.push(item)
  })

  const packets: AsyncIterable<{ data: Uint8Array, from: Addr }> = {
    [Symbol.asyncIterator] () {
      return {
        next () {
          if (closed) return Promise.resolve({ value: undefined as any, done: true })
          if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false })
          return new Promise(resolve => { waiter = resolve })
        }
      }
    }
  }

  return {
    send: (data: Uint8Array, dst: Addr) => new Promise<void>((resolve, reject) => {
      sock.send(data, 0, data.byteLength, dst.port, dst.host, (err: Error | null) =>
        err ? reject(err) : resolve())
    }),
    packets,
    close: () => new Promise<void>(resolve => {
      closed = true
      if (waiter) { const w = waiter; waiter = null; w({ value: undefined as any, done: true }) }
      sock.close(() => resolve())
    })
  }
}

// Tracker URLs come back from libtorrent fully-formed and DNS resolution
// runs through Emscripten's getaddrinfo override. @webvpn/net itself accepts
// hostnames, so for resolve() we just return the input — actual resolution
// happens inside the proxy.
const resolve = async (host: string): Promise<string[]> => [host]

export const installSocketBridge = () => {
  ;(globalThis as any).__ripple_sockets = { tcpConnect, udpBind, resolve }
}
