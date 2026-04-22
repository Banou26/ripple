//go:build js && wasm

package main

import (
	"errors"
	"syscall/js"
)

// installAPI registers the runtime namespace on globalThis.__ripple. The TS
// engine (src/engine/wasm-loader.ts) looks for this object as soon as
// wasm_exec.js finishes bootstrapping.

func installAPI(e *Engine) {
	ns := js.Global().Get("Object").New()

	ns.Set("addTorrent", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) < 2 {
			return promise(func() (js.Value, error) { return js.Undefined(), errors.New("addTorrent(input, storageId)") })
		}
		input, storage := args[0], args[1].String()
		return promise(func() (js.Value, error) {
			var ih string
			var err error
			if input.Type() == js.TypeString {
				ih, err = e.AddMagnet(input.String(), storage)
			} else {
				ih, err = e.AddTorrentFile(uint8ArrayToBytes(input), storage)
			}
			if err != nil {
				return js.Undefined(), err
			}
			return js.ValueOf(ih), nil
		})
	}))

	ns.Set("removeTorrent", js.FuncOf(func(_ js.Value, args []js.Value) any {
		ih, del := args[0].String(), args[1].Bool()
		return promise(func() (js.Value, error) { return js.Undefined(), e.Remove(ih, del) })
	}))

	ns.Set("setFilePriority", js.FuncOf(func(_ js.Value, args []js.Value) any {
		ih, fi, pri := args[0].String(), args[1].Int(), args[2].Int()
		return promise(func() (js.Value, error) { return js.Undefined(), e.SetFilePriority(ih, fi, pri) })
	}))

	ns.Set("setReadahead", js.FuncOf(func(_ js.Value, args []js.Value) any {
		ih, fi := args[0].String(), args[1].Int()
		offset := int64(args[2].Float())
		bytes := int64(args[3].Float())
		return promise(func() (js.Value, error) { return js.Undefined(), e.SetReadahead(ih, fi, offset, bytes) })
	}))

	ns.Set("list", js.FuncOf(func(_ js.Value, args []js.Value) any {
		return promise(func() (js.Value, error) {
			items := e.List()
			return toJSAny(items), nil
		})
	}))

	ns.Set("status", js.FuncOf(func(_ js.Value, args []js.Value) any {
		ih := args[0].String()
		return promise(func() (js.Value, error) {
			st, err := e.Status(ih)
			if err != nil {
				return js.Undefined(), err
			}
			return toJSAny(st), nil
		})
	}))

	ns.Set("read", js.FuncOf(func(_ js.Value, args []js.Value) any {
		ih, fi := args[0].String(), args[1].Int()
		offset := int64(args[2].Float())
		length := int64(args[3].Float())
		return promise(func() (js.Value, error) {
			b, err := e.Read(ih, fi, offset, length)
			if err != nil {
				return js.Undefined(), err
			}
			return bytesToUint8Array(b), nil
		})
	}))

	ns.Set("subscribe", js.FuncOf(func(_ js.Value, args []js.Value) any {
		cb := args[0] // JS function
		cancel := e.Subscribe(func(alert map[string]any) {
			cb.Invoke(toJSAny(alert))
		})
		return js.FuncOf(func(js.Value, []js.Value) any {
			cancel()
			return nil
		})
	}))

	ns.Set("pause", js.FuncOf(func(_ js.Value, args []js.Value) any {
		return promise(func() (js.Value, error) { e.Pause(); return js.Undefined(), nil })
	}))
	ns.Set("resume", js.FuncOf(func(_ js.Value, args []js.Value) any {
		return promise(func() (js.Value, error) { e.Resume(); return js.Undefined(), nil })
	}))

	ns.Set("saveState", js.FuncOf(func(_ js.Value, args []js.Value) any {
		return promise(func() (js.Value, error) { return bytesToUint8Array(e.SaveState()), nil })
	}))
	ns.Set("loadState", js.FuncOf(func(_ js.Value, args []js.Value) any {
		b := uint8ArrayToBytes(args[0])
		return promise(func() (js.Value, error) { e.LoadState(b); return js.Undefined(), nil })
	}))

	js.Global().Set("__ripple", ns)

	// Signal readiness so the loader's awaiter can resolve.
	if ready := js.Global().Get("__ripple_ready"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}
}

// toJSAny recursively converts Go maps/slices/primitives into js.Value. It
// handles the common shapes we hand back to JS: maps keyed by string,
// slices of maps, ints, floats, int64 (float-promoted), strings, bools.
func toJSAny(v any) js.Value {
	switch x := v.(type) {
	case nil:
		return js.Null()
	case string:
		return js.ValueOf(x)
	case bool:
		return js.ValueOf(x)
	case int:
		return js.ValueOf(x)
	case int64:
		return js.ValueOf(float64(x))
	case float64:
		return js.ValueOf(x)
	case []byte:
		return bytesToUint8Array(x)
	case map[string]any:
		o := js.Global().Get("Object").New()
		for k, vv := range x {
			o.Set(k, toJSAny(vv))
		}
		return o
	case []map[string]any:
		a := js.Global().Get("Array").New(len(x))
		for i, vv := range x {
			a.SetIndex(i, toJSAny(vv))
		}
		return a
	case []any:
		a := js.Global().Get("Array").New(len(x))
		for i, vv := range x {
			a.SetIndex(i, toJSAny(vv))
		}
		return a
	case js.Value:
		return x
	default:
		return js.Undefined()
	}
}
