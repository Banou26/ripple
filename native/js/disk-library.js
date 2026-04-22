// Stub --js-library for the disk path. The real disk implementation lives
// in src/engine/disk-opfs.ts and is reached via globalThis.__ripple_disk
// (set up before the wasm module is instantiated).
//
// This file exists so EM_ASYNC_JS in ripple_disk_io.cpp finds its symbols
// without us having to declare them inline. It also lets us add stats hooks
// later without touching C++.

mergeInto(LibraryManager.library, {
  $RIPPLE_DISK__deps: [],
  $RIPPLE_DISK: {
    api: function () {
      const a = globalThis.__ripple_disk;
      if (!a) throw new Error('__ripple_disk not registered on worker global');
      return a;
    }
  }
});
