//go:build js && wasm

package main

import (
	"fmt"
	"syscall/js"
)

// Entry point. The Go WASM runtime requires main() to stay alive for the
// process to keep receiving callbacks from JS; without the terminal
// select{} the runtime exits as soon as main returns.

func main() {
	defer func() {
		if r := recover(); r != nil {
			js.Global().Get("console").Call("error",
				js.ValueOf(fmt.Sprintf("ripple: fatal panic: %v", r)))
		}
	}()

	e, err := NewEngine()
	if err != nil {
		js.Global().Get("console").Call("error",
			js.ValueOf("ripple: engine init failed: "+err.Error()))
		return
	}

	installAPI(e)

	// Park the main goroutine forever. Callbacks from JS drive the rest.
	select {}
}
