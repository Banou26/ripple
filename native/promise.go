//go:build js && wasm

package main

import (
	"syscall/js"
)

// promise runs fn in a goroutine and returns a JS Promise that settles with
// its result. fn returns (value, error); a non-nil error causes rejection
// with a JS Error whose message is err.Error().
//
// This is the canonical pattern for exposing blocking Go work to JavaScript
// on GOOS=js: js.FuncOf handlers must be fast and non-blocking, so anything
// interesting runs inside a goroutine and signals back through a Promise.
func promise(fn func() (js.Value, error)) js.Value {
	return js.Global().Get("Promise").New(js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			defer func() {
				if r := recover(); r != nil {
					reject.Invoke(jsError("panic: " + toString(r)))
				}
			}()
			v, err := fn()
			if err != nil {
				reject.Invoke(jsError(err.Error()))
				return
			}
			resolve.Invoke(v)
		}()
		return nil
	}))
}

func jsError(msg string) js.Value {
	return js.Global().Get("Error").New(msg)
}

func toString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if e, ok := v.(error); ok {
		return e.Error()
	}
	return "unknown"
}

// uint8ArrayToBytes copies a JS Uint8Array into a fresh []byte.
func uint8ArrayToBytes(arr js.Value) []byte {
	n := arr.Get("byteLength").Int()
	out := make([]byte, n)
	js.CopyBytesToGo(out, arr)
	return out
}

// bytesToUint8Array copies a []byte into a fresh JS Uint8Array.
func bytesToUint8Array(b []byte) js.Value {
	arr := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(arr, b)
	return arr
}
