import type {
  ClientControlMessage,
  CoordinatorControlMessage,
  EngineBootstrapMessage,
  EngineHandle,
  EnginePhase,
  EngineRequest,
  EngineWorkerMessage,
  Persisted,
  RuntimeMode,
  TorrentOperation,
  TorrentSnapshot as WorkerTorrentSnapshot,
} from './protocol'

import { relayWorker } from '@fkn/lib'

import { createRecentRateTracker } from './recent-rate'
import { COORDINATOR_NAME, PROTOCOL_VERSION } from './protocol'

export type { EngineHandle, EnginePhase, Persisted, RuntimeMode }
export type TorrentSnapshot = WorkerTorrentSnapshot & {
  ref: EngineHandle
  displayDownloadRate: number
  engineGeneration: number
}

type Transport = Worker | MessagePort

type Pending = {
  generation: number
  resolve: (value: any) => void
  reject: (error: Error) => void
}

type HostedEngine = {
  assignmentId: string
  worker: Worker
  relayAbort: AbortController
}

export type TorrentClient = {
  mode: RuntimeMode
  ready: Promise<void>
  onPhase: (cb: (phase: EnginePhase) => void) => () => void
  onState: (cb: (torrents: TorrentSnapshot[]) => void) => () => void
  onList: (cb: (list: Persisted[]) => void) => () => void
  onStorageUnavailable: (cb: (unavailable: boolean) => void) => () => void
  onPlaybackRevoked: (cb: (infoHash: string) => void) => () => void
  importList: (list: Persisted[]) => Promise<void>
  clearList: () => Promise<void>
  addMagnet: (magnet: string, savePath?: string) => Promise<void>
  addTorrentFile: (bytes: Uint8Array, savePath?: string) => Promise<void>
  start: (infoHash: string) => Promise<void>
  removeMissing: (infoHash: string) => Promise<void>
  read: (ref: EngineHandle, fileIndex: number, offset: number, len: number, prioritize?: boolean) => Promise<Uint8Array>
  pause: (ref: EngineHandle) => Promise<void>
  resume: (ref: EngineHandle) => Promise<void>
  remove: (ref: EngineHandle, deleteFiles?: boolean) => Promise<void>
  acquirePlayback: (leaseId: string, infoHash: string, ref: EngineHandle, fileIndex: number, fromOffset?: number) => Promise<void>
  releasePlayback: (leaseId: string, infoHash: string, ref?: EngineHandle) => Promise<void>
  prioritizeFile: (ref: EngineHandle, fileIndex: number, fromOffset?: number) => Promise<void>
  prioritizeRange: (ref: EngineHandle, fileIndex: number, offset: number, len: number) => Promise<void>
  checkpoint: () => Promise<void>
  destroy: () => void
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })

export const createTorrentClient = (mode: RuntimeMode): TorrentClient => {
  const stateCbs = new Set<(torrents: TorrentSnapshot[]) => void>()
  const listCbs = new Set<(list: Persisted[]) => void>()
  const phaseCbs = new Set<(phase: EnginePhase) => void>()
  const storageUnavailableCbs = new Set<(unavailable: boolean) => void>()
  const playbackRevokedCbs = new Set<(infoHash: string) => void>()
  const pending = new Map<number, Pending>()
  const recentRate = createRecentRateTracker()
  const lifecycle = new AbortController()

  let phase: EnginePhase = 'connecting'
  let latestState: TorrentSnapshot[] | undefined
  let latestList: Persisted[] | undefined
  let storageUnavailable = false
  let generation = mode === 'dedicated' ? 1 : 0
  let nextRequestId = 0
  let transport: Transport | undefined
  let dedicatedWorker: Worker | undefined
  let sharedWorker: SharedWorker | undefined
  let hostedEngine: HostedEngine | undefined
  let relayAbort: AbortController | undefined
  let releaseLivenessLock: (() => void) | undefined
  let destroyed = false
  let closing = false
  let transportSettled = false

  let resolveTransport!: () => void
  let rejectTransport!: (error: Error) => void
  const transportReady = new Promise<void>((resolve, reject) => {
    resolveTransport = () => {
      if (transportSettled) return
      transportSettled = true
      resolve()
    }
    rejectTransport = (error) => {
      if (transportSettled) return
      transportSettled = true
      reject(error)
    }
  })
  transportReady.catch(() => {})

  const readyWaiters = new Set<{ resolve: () => void, reject: (error: Error) => void }>()
  const waitUntilReady = (): Promise<void> => {
    if (phase === 'ready') return Promise.resolve()
    if (destroyed || phase === 'fatal' || phase === 'incompatible' || phase === 'storage-unavailable') {
      return Promise.reject(new Error(destroyed ? 'torrent client destroyed' : `torrent engine ${phase}`))
    }
    return new Promise<void>((resolve, reject) => { readyWaiters.add({ resolve, reject }) })
  }
  const ready = waitUntilReady()
  ready.catch(() => {})

  const rejectReady = (error: Error) => {
    for (const waiter of readyWaiters) waiter.reject(error)
    readyWaiters.clear()
  }

  const rejectPending = (error: Error, beforeGeneration?: number) => {
    for (const [id, request] of pending) {
      if (beforeGeneration !== undefined && request.generation >= beforeGeneration) continue
      request.reject(error)
      pending.delete(id)
    }
  }

  const publishState = (state: TorrentSnapshot[]) => {
    latestState = state
    stateCbs.forEach((cb) => cb(state))
  }

  const setGeneration = (next: number) => {
    if (next <= generation) return
    generation = next
    recentRate.retain(new Set())
    publishState([])
    rejectPending(new Error('torrent engine restarted'), next)
  }

  const setPhase = (next: EnginePhase) => {
    phase = next
    phaseCbs.forEach((cb) => cb(next))
    if (next === 'ready') {
      for (const waiter of readyWaiters) waiter.resolve()
      readyWaiters.clear()
    } else if (next === 'fatal' || next === 'incompatible' || next === 'storage-unavailable') {
      rejectReady(new Error(`torrent engine ${next}`))
    } else if (next === 'restarting') {
      publishState([])
      recentRate.retain(new Set())
      rejectPending(new Error('torrent engine restarted'))
    }
  }

  const decorate = (snapshots: WorkerTorrentSnapshot[]): TorrentSnapshot[] => {
    const handles = new Set<number>()
    const at = performance.now()
    const torrents = snapshots.map((torrent): TorrentSnapshot => {
      handles.add(torrent.handle)
      const stopped = torrent.status?.paused || torrent.status?.state === 4 || torrent.status?.state === 5
      if (stopped) recentRate.reset(torrent.handle)
      return {
        ...torrent,
        ref: {
          handle: torrent.handle,
          engineGeneration: generation,
          infoHash: torrent.infoHash ?? undefined,
        },
        engineGeneration: generation,
        displayDownloadRate: stopped
          ? 0
          : torrent.status
            ? recentRate.sample(torrent.handle, torrent.status.totalDone, at) ?? torrent.status.downloadRate
            : 0,
      }
    })
    recentRate.retain(handles)
    return torrents
  }

  const publishEvent = (topic: string, payload: any, nextGeneration = generation) => {
    if (nextGeneration < generation) return
    setGeneration(nextGeneration)
    if (topic === 'phase') {
      setPhase(payload as EnginePhase)
    } else if (topic === 'state') {
      publishState(decorate(payload as WorkerTorrentSnapshot[]))
    } else if (topic === 'list') {
      latestList = payload as Persisted[]
      listCbs.forEach((cb) => cb(latestList!))
    } else if (topic === 'storage') {
      storageUnavailable = payload?.available === false
      storageUnavailableCbs.forEach((cb) => cb(storageUnavailable))
    } else if (topic === 'playback-revoked') {
      playbackRevokedCbs.forEach((cb) => cb(String(payload?.infoHash ?? '')))
    } else if (topic === 'worker-error') {
      console.warn('[torrent worker]', payload)
    }
  }

  const post = (message: ClientControlMessage | EngineRequest, transfer?: Transferable[]) => {
    if (!transport) throw new Error('torrent transport unavailable')
    transport.postMessage(message, transfer ?? [])
  }

  const fail = (error: Error, terminalPhase: EnginePhase = 'fatal') => {
    rejectTransport(error)
    rejectReady(error)
    rejectPending(error)
    if (!destroyed) setPhase(terminalPhase)
  }

  const handleResponse = (message: { id: number, ok: boolean, value?: any, error?: string, engineGeneration?: number }) => {
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.engineGeneration !== undefined && message.engineGeneration !== request.generation) {
      request.reject(new Error('STALE_GENERATION'))
    } else if (message.ok) {
      request.resolve(message.value)
    } else {
      request.reject(new Error(message.error || 'torrent request failed'))
    }
  }

  const holdLivenessLock = async (lockName: string) => {
    if (!navigator.locks) return
    let settle!: (acquired: boolean) => void
    const acquired = new Promise<boolean>((resolve) => { settle = resolve })
    void navigator.locks.request(lockName, { signal: lifecycle.signal }, async () => {
      if (destroyed) { settle(false); return }
      settle(true)
      await new Promise<void>((resolve) => { releaseLivenessLock = resolve })
    }).catch((error) => {
      settle(false)
      if (error?.name !== 'AbortError' && !destroyed) fail(error instanceof Error ? error : new Error(String(error)))
    })
    if (await acquired && !destroyed) post({ kind: 'liveness-ready' })
  }

  const stopHostedEngine = (assignmentId: string, notify: boolean) => {
    const current = hostedEngine
    if (!current || current.assignmentId !== assignmentId) return
    hostedEngine = undefined
    current.relayAbort.abort()
    current.worker.terminate()
    if (notify && !destroyed) {
      try { post({ kind: 'engine-host-stopped', assignmentId }) } catch {}
    }
  }

  const becomeEngineHost = (assignmentId: string, port: MessagePort) => {
    if (destroyed) {
      port.close()
      return
    }
    if (hostedEngine) stopHostedEngine(hostedEngine.assignmentId, true)
    let worker: Worker | undefined
    let hostRelayAbort: AbortController | undefined
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      hostRelayAbort = new AbortController()
      relayWorker(worker, { unregisterSignal: hostRelayAbort.signal })
      const current: HostedEngine = { assignmentId, worker, relayAbort: hostRelayAbort }
      hostedEngine = current
      worker.addEventListener('error', (event) => {
        if (hostedEngine !== current) return
        stopHostedEngine(assignmentId, false)
        try { post({ kind: 'engine-host-error', assignmentId, error: event.message }) } catch {}
      })
      const bootstrap: EngineBootstrapMessage = { kind: 'attach-engine', port }
      worker.postMessage(bootstrap, [port])
    } catch (error) {
      hostRelayAbort?.abort()
      worker?.terminate()
      port.close()
      try { post({ kind: 'engine-host-error', assignmentId, error: String(error) }) } catch {}
    }
  }

  const onSharedMessage = (event: MessageEvent<CoordinatorControlMessage>) => {
    const message = event.data
    if (!message || typeof message !== 'object') return
    if (message.kind === 'welcome') {
      setGeneration(message.engineGeneration)
      setPhase(message.phase)
      resolveTransport()
      void holdLivenessLock(message.livenessLockName)
    } else if (message.kind === 'response') {
      handleResponse(message)
    } else if (message.kind === 'event') {
      publishEvent(message.topic, message.payload, message.engineGeneration)
    } else if (message.kind === 'become-engine-host') {
      setGeneration(message.engineGeneration)
      becomeEngineHost(message.assignmentId, message.port)
    } else if (message.kind === 'stop-engine-host') {
      stopHostedEngine(message.assignmentId, true)
    }
  }

  const onEngineMessage = (event: MessageEvent<EngineWorkerMessage>) => {
    const message = event.data
    if (!message || typeof message !== 'object') return
    if (message.kind === 'response') handleResponse(message)
    else if (message.kind === 'event') publishEvent(message.topic, message.payload)
  }

  const attachTransport = (next: Transport, listener: (event: MessageEvent<any>) => void) => {
    transport = next
    next.addEventListener('message', listener as EventListener)
    if (next instanceof MessagePort) next.start()
  }

  const stopDedicatedWorker = () => {
    relayAbort?.abort()
    relayAbort = undefined
    dedicatedWorker?.terminate()
    dedicatedWorker = undefined
    if (transport instanceof MessagePort) transport.close()
    transport = undefined
  }

  const startDedicatedWorker = () => {
    if (destroyed) return
    let channel: MessageChannel | undefined
    try {
      dedicatedWorker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      relayAbort = new AbortController()
      relayWorker(dedicatedWorker, { unregisterSignal: relayAbort.signal })
      dedicatedWorker.addEventListener('error', (event) => {
        stopDedicatedWorker()
        fail(new Error(`torrent worker error: ${event.message}`))
      })
      channel = new MessageChannel()
      attachTransport(channel.port1, onEngineMessage)
      const bootstrap: EngineBootstrapMessage = { kind: 'attach-engine', port: channel.port2 }
      dedicatedWorker.postMessage(bootstrap, [channel.port2])
      resolveTransport()
    } catch (error) {
      channel?.port1.close()
      channel?.port2.close()
      stopDedicatedWorker()
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  if (mode === 'shared') {
    try {
      sharedWorker = new SharedWorker(new URL('./coordinator.ts', import.meta.url), {
        type: 'module',
        name: COORDINATOR_NAME,
      })
      sharedWorker.addEventListener('error', (event) => fail(new Error(`torrent coordinator error: ${event.message}`)))
      attachTransport(sharedWorker.port, onSharedMessage)
      post({
        kind: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        buildId: __COMMIT_HASH__,
        clientId: crypto.randomUUID(),
        capabilities: { webLocks: Boolean(navigator.locks), engineHost: typeof Worker !== 'undefined' },
      })
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  } else {
    startDedicatedWorker()
  }

  const request = async <T>(
    op: TorrentOperation,
    payload?: any,
    transfer?: Transferable[],
    skipReady = false,
    requestGeneration?: number,
  ): Promise<T> => {
    if (destroyed) throw new Error('torrent client destroyed')
    await transportReady
    if (!skipReady) await waitUntilReady()
    const effectiveGeneration = requestGeneration ?? generation
    if (effectiveGeneration !== generation) throw new Error('STALE_GENERATION')
    const id = ++nextRequestId
    const response = new Promise<T>((resolve, reject) => {
      pending.set(id, { generation: effectiveGeneration, resolve, reject })
    })
    try {
      post({ kind: 'request', id, op, payload, engineGeneration: effectiveGeneration }, transfer)
    } catch (error) {
      pending.delete(id)
      throw error
    }
    return response
  }

  const target = (ref: EngineHandle) => ({ handle: ref.handle, infoHash: ref.infoHash })

  const checkpointOnPageHide = () => {
    const ownsEngine = mode === 'dedicated' || Boolean(hostedEngine)
    if (!destroyed && ownsEngine && phase === 'ready') void request('checkpoint').catch(() => {})
  }
  window.addEventListener('pagehide', checkpointOnPageHide)

  const destroy = () => {
    if (closing || destroyed) return
    closing = true
    window.removeEventListener('pagehide', checkpointOnPageHide)
    lifecycle.abort()
    releaseLivenessLock?.()

    if (mode === 'shared') {
      try { post({ kind: 'disconnect' }) } catch {}
      if (hostedEngine) stopHostedEngine(hostedEngine.assignmentId, false)
      if (transport instanceof MessagePort) transport.close()
      destroyed = true
      const error = new Error('torrent client destroyed')
      rejectTransport(error)
      rejectReady(error)
      rejectPending(error)
      return
    }

    void withTimeout(request('checkpoint-and-shutdown', undefined, undefined, true), 4_000)
      .catch(() => {})
      .finally(() => {
        destroyed = true
        stopDedicatedWorker()
        const error = new Error('torrent client destroyed')
        rejectReady(error)
        rejectPending(error)
      })
  }

  return {
    mode,
    ready,
    onPhase: (cb) => { phaseCbs.add(cb); cb(phase); return () => { phaseCbs.delete(cb) } },
    onState: (cb) => { stateCbs.add(cb); if (latestState) cb(latestState); return () => { stateCbs.delete(cb) } },
    onList: (cb) => { listCbs.add(cb); if (latestList) cb(latestList); return () => { listCbs.delete(cb) } },
    onStorageUnavailable: (cb) => {
      storageUnavailableCbs.add(cb)
      cb(storageUnavailable)
      return () => { storageUnavailableCbs.delete(cb) }
    },
    onPlaybackRevoked: (cb) => { playbackRevokedCbs.add(cb); return () => { playbackRevokedCbs.delete(cb) } },
    importList: (list) => request('import-list', { list }),
    clearList: () => request('clear-list'),
    addMagnet: (magnet, savePath) => request('add-magnet', { magnet, savePath }),
    addTorrentFile: (bytes, savePath) => request('add-torrent-file', { bytes, savePath }, [bytes.buffer]),
    start: (infoHash) => request('start', { infoHash }),
    removeMissing: (infoHash) => request('remove-missing', { infoHash }),
    read: (ref, fileIndex, offset, len, prioritize = true) =>
      request<Uint8Array>('read', { ...target(ref), fileIndex, offset, len, prioritize }, undefined, false, ref.engineGeneration),
    pause: (ref) => request('pause', target(ref), undefined, false, ref.engineGeneration),
    resume: (ref) => request('resume', target(ref), undefined, false, ref.engineGeneration),
    remove: (ref, deleteFiles = false) => request('remove', { ...target(ref), deleteFiles }, undefined, false, ref.engineGeneration),
    acquirePlayback: (leaseId, infoHash, ref, fileIndex, fromOffset = 0) =>
      request('acquire-playback', { ...target(ref), leaseId, infoHash, fileIndex, fromOffset }, undefined, false, ref.engineGeneration),
    releasePlayback: (leaseId, infoHash, ref) => {
      const payload = { ...(ref ? target(ref) : {}), leaseId, infoHash }
      return request('release-playback', payload, undefined, false, mode === 'dedicated' ? ref?.engineGeneration : undefined)
    },
    prioritizeFile: (ref, fileIndex, fromOffset = 0) =>
      request('prioritize-file', { ...target(ref), fileIndex, fromOffset }, undefined, false, ref.engineGeneration),
    prioritizeRange: (ref, fileIndex, offset, len) =>
      request('prioritize-range', { ...target(ref), fileIndex, offset, len }, undefined, false, ref.engineGeneration),
    checkpoint: () => request('checkpoint'),
    destroy,
  }
}
