import type {
  ClientControlMessage,
  ClientHello,
  ClientRequest,
  CoordinatorControlMessage,
  CoordinatorEvent,
  EnginePhase,
  EngineRequest,
  EngineWorkerMessage,
  Persisted,
  TorrentSnapshot,
} from './protocol'

import { magnetInfoHash } from './magnet'
import { PROTOCOL_VERSION } from './protocol'

type Actor = {
  id: string
  port: MessagePort
  connectedAt: number
  clientId?: string
  livenessLockName: string
  compatible: boolean
  livenessReady: boolean
  hostCandidate: boolean
}

type PendingActorRequest = {
  type: 'actor'
  actorId: string
  clientRequestId: number
  mutation: boolean
  detached: boolean
  done?: () => void
}

type PendingInternalRequest = {
  type: 'internal'
  resolve: (value: any) => void
  reject: (error: Error) => void
}

type PendingEngineRequest = PendingActorRequest | PendingInternalRequest

type PlaybackLease = {
  id: string
  actorId: string
  infoHash: string
  handle: number
  fileIndex: number
  fromOffset: number
  appliedGeneration: number
}

type HostAssignment = {
  id: string
  actorId: string
  generation: number
  port: MessagePort
  attached: boolean
  timer: number
}

type QueuedMutation = {
  actorId: string
  request: ClientRequest
  run: (actor: Actor, request: ClientRequest) => Promise<void>
}

const actors = new Map<string, Actor>()
const pendingEngine = new Map<number, PendingEngineRequest>()
const playbackLeases = new Map<string, PlaybackLease>()
const playbackReservations = new Map<string, string>()
const mutationQueue: QueuedMutation[] = []
const failedHosts = new Set<string>()
const stopWaiters = new Map<string, () => void>()
const coordinatorId = crypto.randomUUID()
const coordinatorBuildId = __COMMIT_HASH__

let phase: EnginePhase = 'connecting'
let engineGeneration = 0
let eventSequence = 0
let nextEngineRequestId = 0
let assignment: HostAssignment | undefined
let activeMutation: QueuedMutation | undefined
let latestList: Persisted[] | undefined
let latestState: TorrentSnapshot[] | undefined
let latestStorage: any
let restarting = false
let incompatible = false

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = self.setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (value) => { self.clearTimeout(timer); resolve(value) },
      (error) => { self.clearTimeout(timer); reject(error) },
    )
  })

const post = (actor: Actor, message: CoordinatorControlMessage, transfer?: Transferable[]) => {
  try { actor.port.postMessage(message, transfer ?? []) } catch {}
}

const event = (topic: CoordinatorEvent['topic'], payload?: any, target?: Actor) => {
  const message: CoordinatorEvent = {
    kind: 'event',
    topic,
    sequence: ++eventSequence,
    engineGeneration,
    payload,
  }
  if (target) post(target, message)
  else for (const actor of actors.values()) if (actor.compatible) post(actor, message)
}

const setPhase = (next: EnginePhase) => {
  phase = next
  event('phase', next)
}

const clearLiveState = () => {
  latestState = []
  event('state', latestState)
}

const replaySticky = (actor: Actor) => {
  event('phase', phase, actor)
  if (latestList) event('list', latestList, actor)
  if (latestState) event('state', latestState, actor)
  if (latestStorage !== undefined) event('storage', latestStorage, actor)
}

const response = (actor: Actor, id: number, ok: boolean, value?: any, error?: string) => {
  const message = { kind: 'response', id, ok, value, error, engineGeneration } as const
  if (value instanceof Uint8Array) post(actor, message, [value.buffer])
  else post(actor, message)
}

const rejectPending = (reason: string) => {
  for (const pending of pendingEngine.values()) {
    if (pending.type === 'actor') {
      const actor = actors.get(pending.actorId)
      if (actor && !pending.detached) response(actor, pending.clientRequestId, false, undefined, reason)
      pending.done?.()
    } else {
      pending.reject(new Error(reason))
    }
  }
  pendingEngine.clear()
}

const rejectQueuedMutations = (reason: string) => {
  for (const queued of mutationQueue.splice(0)) {
    const actor = actors.get(queued.actorId)
    if (actor) response(actor, queued.request.id, false, undefined, reason)
  }
}

const requestEngine = <T>(op: EngineRequest['op'], payload?: any, transfer?: Transferable[]): Promise<T> => {
  if (!assignment) return Promise.reject(new Error('engine unavailable'))
  const id = ++nextEngineRequestId
  const result = new Promise<T>((resolve, reject) => {
    pendingEngine.set(id, { type: 'internal', resolve, reject })
  })
  assignment.port.postMessage({ kind: 'request', id, op, payload } satisfies EngineRequest, transfer ?? [])
  return result
}

const validateRequest = (actor: Actor, request: ClientRequest): string | undefined => {
  if (!assignment || phase !== 'ready') return 'ENGINE_NOT_READY'
  if (request.engineGeneration !== engineGeneration) return 'STALE_GENERATION'
  if (!actors.has(actor.id)) return 'ACTOR_DISCONNECTED'
}

const forwardRequest = (actor: Actor, request: ClientRequest, mutation: boolean): Promise<void> => {
  const invalid = validateRequest(actor, request)
  if (invalid) {
    response(actor, request.id, false, undefined, invalid)
    return Promise.resolve()
  }

  const id = ++nextEngineRequestId
  let complete!: () => void
  const completed = new Promise<void>((resolve) => { complete = resolve })
  pendingEngine.set(id, {
    type: 'actor',
    actorId: actor.id,
    clientRequestId: request.id,
    mutation,
    detached: false,
    done: complete,
  })
  const transfer = request.op === 'add-torrent-file' && request.payload?.bytes instanceof Uint8Array
    ? [request.payload.bytes.buffer]
    : []
  try {
    assignment!.port.postMessage({ kind: 'request', id, op: request.op, payload: request.payload } satisfies EngineRequest, transfer)
  } catch (error) {
    pendingEngine.delete(id)
    response(actor, request.id, false, undefined, String(error))
    complete()
    return Promise.resolve()
  }
  return completed
}

const findSnapshot = (infoHash: string): TorrentSnapshot | undefined =>
  latestState?.find((snapshot) => snapshot.infoHash === infoHash || magnetInfoHash(snapshot.magnet) === infoHash)

const applyPlaybackLeases = () => {
  if (phase !== 'ready') return
  for (const lease of playbackLeases.values()) {
    if (lease.appliedGeneration === engineGeneration) continue
    const snapshot = findSnapshot(lease.infoHash)
    if (!snapshot) continue
    lease.handle = snapshot.handle
    void requestEngine('acquire-playback', {
      handle: snapshot.handle,
      infoHash: lease.infoHash,
      fileIndex: lease.fileIndex,
      fromOffset: lease.fromOffset,
    }).then(
      () => {
        const current = playbackLeases.get(lease.infoHash)
        if (current === lease && actors.has(lease.actorId)) lease.appliedGeneration = engineGeneration
        else if (!current) void requestEngine('release-playback', {
          handle: snapshot.handle,
          infoHash: lease.infoHash,
        }).catch(() => {})
      },
      () => { lease.appliedGeneration = 0 },
    )
  }
}

const releaseLease = (lease: PlaybackLease) => {
  if (playbackLeases.get(lease.infoHash) === lease) playbackLeases.delete(lease.infoHash)
  if (assignment && phase === 'ready' && lease.appliedGeneration === engineGeneration) {
    void requestEngine('release-playback', { handle: lease.handle, infoHash: lease.infoHash }).catch(() => {})
  }
}

const acquirePlayback = async (actor: Actor, request: ClientRequest) => {
  const invalid = validateRequest(actor, request)
  if (invalid) {
    response(actor, request.id, false, undefined, invalid)
    return
  }
  const payload = request.payload ?? {}
  const leaseId = String(payload.leaseId ?? '')
  const infoHash = String(payload.infoHash ?? '')
  const snapshot = findSnapshot(infoHash)
  if (!leaseId || !infoHash || !snapshot) {
    response(actor, request.id, false, undefined, 'STALE_TORRENT_REF')
    return
  }

  const previous = playbackLeases.get(infoHash)
  if (previous && previous.actorId !== actor.id) {
    const owner = actors.get(previous.actorId)
    if (owner) event('playback-revoked', { infoHash }, owner)
    releaseLease(previous)
  }

  const lease: PlaybackLease = {
    id: leaseId,
    actorId: actor.id,
    infoHash,
    handle: snapshot.handle,
    fileIndex: payload.fileIndex,
    fromOffset: payload.fromOffset ?? 0,
    appliedGeneration: 0,
  }
  playbackLeases.set(infoHash, lease)
  try {
    await requestEngine('acquire-playback', {
      handle: snapshot.handle,
      infoHash,
      fileIndex: lease.fileIndex,
      fromOffset: lease.fromOffset,
    })
    const current = playbackLeases.get(infoHash)
    if (current === lease && actors.has(actor.id)) {
      lease.appliedGeneration = engineGeneration
      response(actor, request.id, true)
    } else if (!current) {
      await requestEngine('release-playback', { handle: snapshot.handle, infoHash }).catch(() => {})
    }
  } catch (error) {
    if (playbackLeases.get(infoHash) === lease) playbackLeases.delete(infoHash)
    if (actors.has(actor.id)) response(actor, request.id, false, undefined, String(error))
  }
}

const releasePlayback = async (actor: Actor, request: ClientRequest) => {
  const leaseId = String(request.payload?.leaseId ?? '')
  const infoHash = String(request.payload?.infoHash ?? '')
  const lease = playbackLeases.get(infoHash)
  if (lease?.actorId === actor.id && lease.id === leaseId) releaseLease(lease)
  response(actor, request.id, true)
}

const canPrioritize = (actor: Actor, request: ClientRequest) => {
  if (request.op === 'read' && request.payload?.prioritize === false) return true
  if (request.op !== 'read' && request.op !== 'prioritize-file' && request.op !== 'prioritize-range') return true
  const handle = request.payload?.handle
  const snapshot = latestState?.find((item) => item.handle === handle)
  const reservation = snapshot?.infoHash ? playbackReservations.get(snapshot.infoHash) : undefined
  if (reservation) return reservation === actor.id
  const lease = Array.from(playbackLeases.values()).find((item) => item.handle === handle)
  return !lease || lease.actorId === actor.id
}

const pumpMutations = () => {
  if (activeMutation || restarting) return
  const queued = mutationQueue.shift()
  if (!queued) return
  const actor = actors.get(queued.actorId)
  if (!actor) {
    pumpMutations()
    return
  }
  activeMutation = queued
  void queued.run(actor, queued.request).finally(() => {
    if (activeMutation === queued) activeMutation = undefined
    pumpMutations()
  })
}

const enqueueMutation = (actor: Actor, request: ClientRequest, run: QueuedMutation['run']) => {
  mutationQueue.push({ actorId: actor.id, request, run })
  pumpMutations()
}

const handleClientRequest = (actor: Actor, request: ClientRequest) => {
  if (request.op === 'release-playback') {
    enqueueMutation(actor, request, releasePlayback)
    return
  }
  const invalid = validateRequest(actor, request)
  if (invalid) {
    response(actor, request.id, false, undefined, invalid)
    return
  }
  if (!canPrioritize(actor, request)) {
    response(actor, request.id, false, undefined, 'PLAYBACK_NOT_OWNER')
    return
  }
  if (request.op === 'read') void forwardRequest(actor, request, false)
  else if (request.op === 'acquire-playback') {
    const infoHash = String(request.payload?.infoHash ?? '')
    if (infoHash) playbackReservations.set(infoHash, actor.id)
    enqueueMutation(actor, request, async (currentActor, currentRequest) => {
      if (infoHash && playbackReservations.get(infoHash) === currentActor.id) playbackReservations.delete(infoHash)
      await acquirePlayback(currentActor, currentRequest)
    })
  } else if (request.op === 'remove') {
    enqueueMutation(actor, request, async (currentActor, currentRequest) => {
      const infoHash = String(currentRequest.payload?.infoHash ?? '')
      const lease = playbackLeases.get(infoHash)
      if (lease) releaseLease(lease)
      await forwardRequest(currentActor, currentRequest, true)
    })
  } else enqueueMutation(actor, request, (currentActor, currentRequest) => {
    if (!canPrioritize(currentActor, currentRequest)) {
      response(currentActor, currentRequest.id, false, undefined, 'PLAYBACK_NOT_OWNER')
      return Promise.resolve()
    }
    return forwardRequest(currentActor, currentRequest, true)
  })
}

const markAssignmentAttached = (current: HostAssignment) => {
  if (assignment !== current || current.attached) return
  current.attached = true
  self.clearTimeout(current.timer)
}

const stopHostedEngine = (current: HostAssignment): Promise<void> => {
  const actor = actors.get(current.actorId)
  if (!actor) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = self.setTimeout(() => {
      stopWaiters.delete(current.id)
      resolve()
    }, 3_000)
    stopWaiters.set(current.id, () => {
      self.clearTimeout(timer)
      resolve()
    })
    post(actor, { kind: 'stop-engine-host', assignmentId: current.id })
  })
}

const clearAssignment = (current: HostAssignment) => {
  if (assignment !== current) return
  self.clearTimeout(current.timer)
  current.port.close()
  assignment = undefined
}

const electHost = () => {
  if (assignment || restarting || incompatible) return
  const host = Array.from(actors.values())
    .filter((actor) => actor.compatible && actor.livenessReady && actor.hostCandidate && !failedHosts.has(actor.id))
    .sort((a, b) => a.connectedAt - b.connectedAt)[0]
  if (!host) {
    setPhase('waiting-for-engine-host')
    return
  }

  engineGeneration = Math.max(1, engineGeneration + 1)
  latestState = []
  event('state', latestState)
  setPhase('starting')
  const channel = new MessageChannel()
  const current: HostAssignment = {
    id: crypto.randomUUID(),
    actorId: host.id,
    generation: engineGeneration,
    port: channel.port1,
    attached: false,
    timer: 0,
  }
  assignment = current
  channel.port1.addEventListener('message', (messageEvent: MessageEvent<EngineWorkerMessage>) => {
    if (assignment !== current || current.generation !== engineGeneration) return
    markAssignmentAttached(current)
    onEngineMessage(current, messageEvent.data)
  })
  channel.port1.addEventListener('close', () => {
    if (assignment === current && !restarting) void restartEngine('ENGINE_PORT_CLOSED', true)
  })
  channel.port1.start()
  current.timer = self.setTimeout(() => {
    if (assignment !== current || current.attached) return
    failedHosts.add(host.id)
    void restartEngine('ENGINE_HOST_TIMEOUT', false).finally(() => {
      self.setTimeout(() => {
        failedHosts.delete(host.id)
        electHost()
      }, 2_000)
    })
  }, 8_000)
  post(host, {
    kind: 'become-engine-host',
    assignmentId: current.id,
    engineGeneration,
    port: channel.port2,
  }, [channel.port2])
}

const onEngineMessage = (current: HostAssignment, message: EngineWorkerMessage) => {
  if (assignment !== current || !message || typeof message !== 'object') return
  if (message.kind === 'response') {
    const pending = pendingEngine.get(message.id)
    if (!pending) return
    pendingEngine.delete(message.id)
    if (pending.type === 'internal') {
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new Error(message.error || 'engine request failed'))
      return
    }
    const actor = actors.get(pending.actorId)
    if (actor && !pending.detached) response(actor, pending.clientRequestId, message.ok, message.value, message.error)
    pending.done?.()
    return
  }

  if (message.topic === 'phase') {
    const next = message.payload as EnginePhase
    if (next === 'ready') {
      failedHosts.clear()
      setPhase('ready')
      applyPlaybackLeases()
      pumpMutations()
    } else if (next === 'waiting-for-lock' || next === 'starting') {
      setPhase(next)
    } else if (next === 'storage-unavailable' || next === 'fatal') {
      void stopTerminalEngine(current, next)
    }
    return
  }
  if (message.topic === 'list') latestList = message.payload as Persisted[]
  if (message.topic === 'state') {
    latestState = message.payload as TorrentSnapshot[]
    applyPlaybackLeases()
  }
  if (message.topic === 'storage') latestStorage = message.payload
  event(message.topic, message.payload)
}

const stopTerminalEngine = async (current: HostAssignment, terminal: 'storage-unavailable' | 'fatal') => {
  if (assignment !== current) return
  restarting = true
  rejectQueuedMutations(`ENGINE_${terminal.toUpperCase()}`)
  rejectPending(`ENGINE_${terminal.toUpperCase()}`)
  clearLiveState()
  clearAssignment(current)
  await stopHostedEngine(current)
  restarting = false
  setPhase(terminal)
}

const restartEngine = async (reason: string, hostGone: boolean) => {
  if (restarting) return
  restarting = true
  setPhase('restarting')
  clearLiveState()
  rejectQueuedMutations(reason)
  const current = assignment
  if (current && current.attached && !hostGone) {
    await withTimeout(requestEngine('checkpoint-and-shutdown'), 4_000).catch(() => {})
  }
  rejectPending(reason)
  if (current) {
    clearAssignment(current)
    if (!hostGone) await stopHostedEngine(current)
  }
  activeMutation = undefined
  restarting = false
  if (!incompatible) electHost()
}

const releaseActorLeases = (actorId: string) => {
  for (const lease of Array.from(playbackLeases.values())) if (lease.actorId === actorId) releaseLease(lease)
}

const cleanupActor = (actor: Actor) => {
  if (!actors.delete(actor.id)) return
  releaseActorLeases(actor.id)
  for (const [infoHash, actorId] of playbackReservations) {
    if (actorId === actor.id) playbackReservations.delete(infoHash)
  }
  failedHosts.delete(actor.id)
  for (let index = mutationQueue.length - 1; index >= 0; index--) {
    if (mutationQueue[index]!.actorId === actor.id) mutationQueue.splice(index, 1)
  }
  for (const [id, pending] of pendingEngine) {
    if (pending.type !== 'actor' || pending.actorId !== actor.id) continue
    if (pending.mutation) pending.detached = true
    else pendingEngine.delete(id)
  }
  if (assignment?.actorId === actor.id) void restartEngine('ENGINE_HOST_GONE', true)
}

const watchActorLiveness = (actor: Actor) => {
  const locks = (self.navigator as Navigator).locks
  if (!locks) return
  void locks.request(actor.livenessLockName, async () => { cleanupActor(actor) })
}

const handleHello = (actor: Actor, hello: ClientHello) => {
  actor.clientId = hello.clientId
  actor.compatible = hello.protocolVersion === PROTOCOL_VERSION && hello.buildId === coordinatorBuildId
  actor.hostCandidate = actor.compatible && hello.capabilities.engineHost
  post(actor, {
    kind: 'welcome',
    protocolVersion: PROTOCOL_VERSION,
    coordinatorId,
    coordinatorBuildId,
    actorId: actor.id,
    livenessLockName: actor.livenessLockName,
    engineGeneration,
    phase: actor.compatible ? phase : 'incompatible',
  })
  if (!actor.compatible) return
  replaySticky(actor)
}

const cancelActorRequest = (actor: Actor, requestId: number) => {
  for (let index = mutationQueue.length - 1; index >= 0; index--) {
    const queued = mutationQueue[index]!
    if (queued.actorId !== actor.id || queued.request.id !== requestId) continue
    if (queued.request.op === 'acquire-playback') {
      const infoHash = String(queued.request.payload?.infoHash ?? '')
      if (playbackReservations.get(infoHash) === actor.id) playbackReservations.delete(infoHash)
    }
    mutationQueue.splice(index, 1)
  }
  for (const [id, pending] of pendingEngine) {
    if (pending.type !== 'actor' || pending.actorId !== actor.id || pending.clientRequestId !== requestId) continue
    if (pending.mutation) pending.detached = true
    else pendingEngine.delete(id)
  }
}

const handleActorMessage = (actor: Actor, message: ClientControlMessage) => {
  if (!message || typeof message !== 'object') return
  if (message.kind === 'hello') handleHello(actor, message)
  else if (!actor.compatible) return
  else if (message.kind === 'liveness-ready') {
    actor.livenessReady = true
    watchActorLiveness(actor)
    electHost()
  } else if (message.kind === 'engine-host-error' && assignment?.id === message.assignmentId) {
    failedHosts.add(actor.id)
    void restartEngine('ENGINE_HOST_ERROR', true).finally(() => {
      self.setTimeout(() => {
        failedHosts.delete(actor.id)
        electHost()
      }, 2_000)
    })
  } else if (message.kind === 'engine-host-stopped') {
    const resolve = stopWaiters.get(message.assignmentId)
    stopWaiters.delete(message.assignmentId)
    resolve?.()
  } else if (message.kind === 'request') {
    handleClientRequest(actor, message)
  } else if (message.kind === 'cancel') {
    cancelActorRequest(actor, message.id)
  } else if (message.kind === 'disconnect') {
    cleanupActor(actor)
  }
}

const handleConnect = (port: MessagePort) => {
  const actor: Actor = {
    id: crypto.randomUUID(),
    port,
    connectedAt: performance.now(),
    livenessLockName: `ripple:torrent-client:${crypto.randomUUID()}`,
    compatible: false,
    livenessReady: false,
    hostCandidate: false,
  }
  actors.set(actor.id, actor)
  port.addEventListener('message', (event: MessageEvent<ClientControlMessage>) => handleActorMessage(actor, event.data))
  port.addEventListener('close', () => cleanupActor(actor))
  port.start()
}

const legacyChannel = new BroadcastChannel('ripple-window-instance-guard')
let legacyRecoveryTimer: number | undefined
const probeLegacyRecovery = () => {
  let active = false
  const onMessage = (event: MessageEvent) => { if (event.data === 'active') active = true }
  legacyChannel.addEventListener('message', onMessage)
  legacyChannel.postMessage('check')
  legacyRecoveryTimer = self.setTimeout(() => {
    legacyChannel.removeEventListener('message', onMessage)
    if (active) {
      legacyRecoveryTimer = self.setTimeout(probeLegacyRecovery, 1_000)
      return
    }
    incompatible = false
    electHost()
  }, 150)
}

legacyChannel.addEventListener('message', (legacyEvent) => {
  if (legacyEvent.data === 'check') legacyChannel.postMessage('active')
  else if (legacyEvent.data?.type === 'check-shared') {
    legacyChannel.postMessage({
      type: 'shared-active',
      protocolVersion: PROTOCOL_VERSION,
      buildId: coordinatorBuildId,
    })
  } else if (legacyEvent.data === 'activate') {
    incompatible = true
    if (legacyRecoveryTimer !== undefined) self.clearTimeout(legacyRecoveryTimer)
    void restartEngine('INCOMPATIBLE_RUNTIME', false).finally(probeLegacyRecovery)
  }
})

;(globalThis as unknown as { onconnect: ((event: MessageEvent) => void) | null }).onconnect = (connectEvent) => {
  const port = connectEvent.ports[0]
  if (port) handleConnect(port)
}
