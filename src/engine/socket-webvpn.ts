// Bridge between the Go engine (native/net_js.go) and @webvpn/net +
// @webvpn/dgram. Installed on globalThis.__ripple_sockets before the wasm
// module boots.
//
// Contract the Go side depends on:
//
//   tcpConnect({ host, port }) -> Promise<{
//     readable: ReadableStream<Uint8Array>,
//     writable: { write(u8): Promise<void>, close(): Promise<void> },
//     close(): Promise<void>
//   }>
//
//   udpBind({ host, port }) -> Promise<{
//     send(u8, {host, port}): Promise<void>,
//     recv(): Promise<{data: Uint8Array, from: {host, port}} | null>,
//     close(): Promise<void>
//   }>
//
//   resolve(host) -> Promise<string[]>   // dotted-quad strings

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

  // Bounded queue; the Go drain pulls with recv() as fast as it can.
  const queue: { data: Uint8Array, from: Addr }[] = []
  let waiter: ((v: { data: Uint8Array, from: Addr } | null) => void) | null = null
  let closed = false

  sock.on('message', (msg: Uint8Array, rinfo: { address: string, port: number }) => {
    const u8 = new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength)
    const item = { data: u8, from: { host: rinfo.address, port: rinfo.port } }
    if (waiter) { const w = waiter; waiter = null; w(item) }
    else queue.push(item)
  })

  return {
    send: (data: Uint8Array, dst: Addr) => new Promise<void>((resolve, reject) => {
      sock.send(data, 0, data.byteLength, dst.port, dst.host, (err: Error | null) =>
        err ? reject(err) : resolve())
    }),
    recv: () => new Promise<{ data: Uint8Array, from: Addr } | null>(resolve => {
      if (closed) return resolve(null)
      if (queue.length) return resolve(queue.shift()!)
      waiter = resolve
    }),
    close: () => new Promise<void>(resolve => {
      closed = true
      if (waiter) { const w = waiter; waiter = null; w(null) }
      sock.close(() => resolve())
    })
  }
}

// DNS resolution goes through the proxy; we just pass the hostname through.
const resolve = async (host: string): Promise<string[]> => [host]

export const installSocketBridge = () => {
  ;(globalThis as any).__ripple_sockets = { tcpConnect, udpBind, resolve }
}
