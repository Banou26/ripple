//go:build js && wasm

package main

import (
	"context"
	"errors"
	"io"
	"net"
	"strconv"
	"sync"
	"syscall/js"
	"time"
)

// The browser-side contract (see src/engine/socket-webvpn.ts). All methods
// return JS Promises that resolve to plain JS objects.
//
//   __ripple_sockets.tcpConnect({host, port})
//     -> { readable: ReadableStream<Uint8Array>,
//          writable: { write(u8): Promise<void>, close(): Promise<void> },
//          close(): Promise<void> }
//
//   __ripple_sockets.udpBind({host, port})
//     -> { send(u8, {host, port}): Promise<void>,
//          packets: AsyncIterable<{ data: Uint8Array, from: {host, port} }>,
//          close(): Promise<void> }
//
//   __ripple_sockets.resolve(host) -> Promise<string[]>

func getSocketsAPI() js.Value {
	api := js.Global().Get("__ripple_sockets")
	if api.Type() == js.TypeUndefined {
		panic("globalThis.__ripple_sockets is not installed")
	}
	return api
}

// await blocks the current goroutine until the JS Promise settles. The Go
// runtime on js/wasm is single-threaded but cooperative — this pattern
// (channel + then/catch callbacks) is the standard way to convert a JS
// Promise into a blocking Go call.
func await(p js.Value) (js.Value, error) {
	type result struct {
		v   js.Value
		err error
	}
	ch := make(chan result, 1)
	var thenFn, catchFn js.Func
	thenFn = js.FuncOf(func(_ js.Value, args []js.Value) any {
		ch <- result{v: args[0]}
		thenFn.Release()
		catchFn.Release()
		return nil
	})
	catchFn = js.FuncOf(func(_ js.Value, args []js.Value) any {
		msg := "js rejection"
		if len(args) > 0 {
			if m := args[0].Get("message"); m.Type() == js.TypeString {
				msg = m.String()
			}
		}
		ch <- result{err: errors.New(msg)}
		thenFn.Release()
		catchFn.Release()
		return nil
	})
	p.Call("then", thenFn).Call("catch", catchFn)
	r := <-ch
	return r.v, r.err
}

// ------------- TCP --------------------------------------------------------

// jsDialer implements net.Dialer-shaped behavior for anacrolix's peer
// connection path. The torrent client expects any type satisfying a Dialer
// interface — anacrolix uses its own anacrolix/generics/dialer. For
// simplicity we provide DialContext with the standard signature.
type jsDialer struct{}

func (d *jsDialer) Dial(network, addr string) (net.Conn, error) {
	return d.DialContext(context.Background(), network, addr)
}

func (d *jsDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return nil, errors.New("jsDialer: only tcp* supported")
	}
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return nil, err
	}
	arg := js.Global().Get("Object").New()
	arg.Set("host", host)
	arg.Set("port", port)
	promiseVal := getSocketsAPI().Call("tcpConnect", arg)
	conn, err := await(promiseVal)
	if err != nil {
		return nil, err
	}
	return &jsTCPConn{
		handle:    conn,
		remote:    &net.TCPAddr{IP: net.ParseIP(host), Port: port},
		readQueue: make(chan []byte, 8),
	}, nil
}

type jsTCPConn struct {
	handle    js.Value
	remote    net.Addr
	readQueue chan []byte
	readBuf   []byte // leftover from the previous chunk
	closed    bool
	closeOnce sync.Once

	readerStarted bool
	readerOnce    sync.Once
}

// startReader launches a goroutine that pulls from the JS ReadableStream
// via its default reader and fans chunks out on readQueue. Called lazily.
func (c *jsTCPConn) startReader() {
	c.readerOnce.Do(func() {
		go func() {
			defer close(c.readQueue)
			reader := c.handle.Get("readable").Call("getReader")
			for {
				res, err := await(reader.Call("read"))
				if err != nil || res.Get("done").Bool() {
					return
				}
				value := res.Get("value")
				if value.Type() == js.TypeUndefined {
					return
				}
				c.readQueue <- uint8ArrayToBytes(value)
			}
		}()
	})
}

func (c *jsTCPConn) Read(p []byte) (int, error) {
	c.startReader()
	if len(c.readBuf) == 0 {
		chunk, ok := <-c.readQueue
		if !ok {
			return 0, io.EOF
		}
		c.readBuf = chunk
	}
	n := copy(p, c.readBuf)
	c.readBuf = c.readBuf[n:]
	return n, nil
}

func (c *jsTCPConn) Write(p []byte) (int, error) {
	u8 := bytesToUint8Array(p)
	writable := c.handle.Get("writable")
	_, err := await(writable.Call("write", u8))
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *jsTCPConn) Close() error {
	c.closeOnce.Do(func() {
		c.closed = true
		await(c.handle.Call("close"))
	})
	return nil
}

func (c *jsTCPConn) LocalAddr() net.Addr               { return &net.TCPAddr{} }
func (c *jsTCPConn) RemoteAddr() net.Addr              { return c.remote }
func (c *jsTCPConn) SetDeadline(t time.Time) error     { return nil }
func (c *jsTCPConn) SetReadDeadline(t time.Time) error { return nil }
func (c *jsTCPConn) SetWriteDeadline(t time.Time) error {
	return nil
}

// ------------- UDP --------------------------------------------------------

// jsPacketConn wraps a __ripple_sockets.udpBind handle as a net.PacketConn.
// anacrolix's UDP tracker client and DHT server both operate on net.PacketConn,
// so this single type handles both.
type jsPacketConn struct {
	handle js.Value
	local  net.Addr
	queue  chan udpPacket
	closed bool
	mu     sync.Mutex
}

type udpPacket struct {
	data []byte
	from *net.UDPAddr
}

func ListenUDP() (*jsPacketConn, error) {
	arg := js.Global().Get("Object").New()
	arg.Set("host", "0.0.0.0")
	arg.Set("port", 0)
	handle, err := await(getSocketsAPI().Call("udpBind", arg))
	if err != nil {
		return nil, err
	}
	c := &jsPacketConn{
		handle: handle,
		local:  &net.UDPAddr{IP: net.IPv4zero, Port: 0},
		queue:  make(chan udpPacket, 64),
	}
	go c.drain()
	return c, nil
}

// drain consumes datagrams from the JS side and enqueues them for ReadFrom.
// Rather than reach for Symbol.asyncIterator (which syscall/js can't index
// by a JS Symbol directly), we ask the JS side to expose a plain
// `recv(): Promise<{data, from} | null>` method on the udpBind result. A
// null resolution terminates the drain.
func (c *jsPacketConn) drain() {
	defer close(c.queue)
	for {
		res, err := await(c.handle.Call("recv"))
		if err != nil {
			return
		}
		if res.Type() == js.TypeNull || res.Type() == js.TypeUndefined {
			return
		}
		data := uint8ArrayToBytes(res.Get("data"))
		from := res.Get("from")
		addr := &net.UDPAddr{
			IP:   net.ParseIP(from.Get("host").String()),
			Port: from.Get("port").Int(),
		}
		c.queue <- udpPacket{data: data, from: addr}
	}
}

func (c *jsPacketConn) ReadFrom(p []byte) (int, net.Addr, error) {
	pkt, ok := <-c.queue
	if !ok {
		return 0, nil, io.EOF
	}
	n := copy(p, pkt.data)
	return n, pkt.from, nil
}

func (c *jsPacketConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	udp, ok := addr.(*net.UDPAddr)
	if !ok {
		return 0, errors.New("jsPacketConn: only *net.UDPAddr supported")
	}
	dst := js.Global().Get("Object").New()
	dst.Set("host", udp.IP.String())
	dst.Set("port", udp.Port)
	_, err := await(c.handle.Call("send", bytesToUint8Array(p), dst))
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *jsPacketConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	await(c.handle.Call("close"))
	return nil
}

func (c *jsPacketConn) LocalAddr() net.Addr                { return c.local }
func (c *jsPacketConn) SetDeadline(t time.Time) error      { return nil }
func (c *jsPacketConn) SetReadDeadline(t time.Time) error  { return nil }
func (c *jsPacketConn) SetWriteDeadline(t time.Time) error { return nil }
