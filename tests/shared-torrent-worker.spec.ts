import type { BrowserContext, Page } from '@playwright/test'

import { readFile } from 'node:fs/promises'

import { expect, test } from '@playwright/test'

import { DEMO_SEEDED_KEY } from '../src/torrent/constants'

const MAGNET = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337'

type TraceEvent = {
  type: 'worker-created' | 'worker-terminated' | 'coordinator' | 'request' | 'response'
  url?: string
  workerId?: string
  kind?: string
  topic?: string
  phase?: string
  payload?: string
  generation?: number
  coordinatorId?: string
  actorId?: string
  assignmentId?: string
  id?: number
  op?: string
  ok?: boolean
  error?: string
  bytes?: number
  sample?: number[]
}

const installTrace = (context: BrowserContext) => context.addInitScript((seededKey) => {
  localStorage.setItem(seededKey, '1')
  const root = window as typeof window & {
    __rippleSharedTrace: TraceEvent[]
    __rippleCoordinatorPort?: MessagePort
    __rippleLatestState?: any[]
    __failFirstTorrentWorker?: boolean
    __failedFirstTorrentWorker?: boolean
  }
  root.__rippleSharedTrace = []

  const NativeWorker = window.Worker
  const WrappedWorker = function (url: string | URL, options?: WorkerOptions) {
    if (root.__failFirstTorrentWorker && !root.__failedFirstTorrentWorker && String(url).includes('/assets/worker-')) {
      root.__failedFirstTorrentWorker = true
      throw new Error('injected torrent worker startup failure')
    }
    const worker = new NativeWorker(url, options)
    const workerId = crypto.randomUUID()
    root.__rippleSharedTrace.push({ type: 'worker-created', workerId, url: String(url) })
    const terminate = worker.terminate.bind(worker)
    worker.terminate = () => {
      root.__rippleSharedTrace.push({ type: 'worker-terminated', workerId, url: String(url) })
      terminate()
    }
    return worker
  } as unknown as typeof Worker
  Object.setPrototypeOf(WrappedWorker, NativeWorker)
  WrappedWorker.prototype = NativeWorker.prototype
  Object.defineProperty(window, 'Worker', { configurable: true, writable: true, value: WrappedWorker })

  const NativeSharedWorker = window.SharedWorker
  const WrappedSharedWorker = function (url: string | URL, options?: string | WorkerOptions) {
    const worker = new NativeSharedWorker(url, options)
    const name = typeof options === 'string' ? options : options?.name
    if (name?.startsWith('ripple-torrent-v')) root.__rippleCoordinatorPort = worker.port
    const originalPost = worker.port.postMessage.bind(worker.port)
    worker.port.postMessage = ((message: any, transfer?: Transferable[]) => {
      if (message?.kind === 'request') {
        root.__rippleSharedTrace.push({ type: 'request', id: message.id, op: message.op, generation: message.engineGeneration })
      }
      if (transfer === undefined) originalPost(message)
      else originalPost(message, transfer)
    }) as typeof worker.port.postMessage
    worker.port.addEventListener('message', (event) => {
      const message = event.data
      if (message?.kind === 'response') {
        root.__rippleSharedTrace.push({
          type: 'response',
          id: message.id,
          ok: message.ok,
          error: message.error,
          generation: message.engineGeneration,
          bytes: message.value?.byteLength,
          sample: message.value instanceof Uint8Array ? Array.from(message.value.slice(0, 16)) : undefined,
        })
      } else if (message?.kind === 'welcome' || message?.kind === 'event' || message?.kind === 'become-engine-host') {
        if (message.kind === 'event' && message.topic === 'state') root.__rippleLatestState = message.payload
        root.__rippleSharedTrace.push({
          type: 'coordinator',
          kind: message.kind,
          topic: message.topic,
          phase: message.phase,
          payload: message.topic === 'phase' ? message.payload : undefined,
          generation: message.engineGeneration,
          coordinatorId: message.coordinatorId,
          actorId: message.actorId,
          assignmentId: message.assignmentId,
        })
      }
    })
    return worker
  } as unknown as typeof SharedWorker
  Object.setPrototypeOf(WrappedSharedWorker, NativeSharedWorker)
  WrappedSharedWorker.prototype = NativeSharedWorker.prototype
  Object.defineProperty(window, 'SharedWorker', { configurable: true, writable: true, value: WrappedSharedWorker })
}, DEMO_SEEDED_KEY)

const trace = (page: Page): Promise<TraceEvent[]> =>
  page.evaluate(() => (window as any).__rippleSharedTrace as TraceEvent[])

const waitForReady = (page: Page, generation = 1) => page.waitForFunction(
  (minimum) => (window as any).__rippleSharedTrace.some((event: TraceEvent) =>
    event.topic === 'phase' && event.payload === 'ready' && (event.generation ?? 0) >= minimum
  ),
  generation,
  { timeout: 45_000 },
)

const welcome = async (page: Page) => (await trace(page)).find((event) => event.kind === 'welcome')!
const torrentWorkers = async (page: Page) => (await trace(page)).filter((event) =>
  event.type === 'worker-created' && event.url?.includes('/assets/worker-')
)

test('shares one engine and recovers when its host closes', async ({ browser }) => {
  const context = await browser.newContext()
  const pageErrors: string[] = []
  try {
    await installTrace(context)
    const pageA = await context.newPage()
    pageA.on('pageerror', (error) => pageErrors.push(error.message))
    await pageA.goto('/')
    await waitForReady(pageA)

    const pageB = await context.newPage()
    pageB.on('pageerror', (error) => pageErrors.push(error.message))
    await pageB.goto('/')
    await waitForReady(pageB)

    const welcomeA = await welcome(pageA)
    const welcomeB = await welcome(pageB)
    expect(welcomeA.coordinatorId).toBe(welcomeB.coordinatorId)
    expect(welcomeA.actorId).not.toBe(welcomeB.actorId)
    expect(welcomeA.generation).toBe(0)
    expect(welcomeB.generation).toBe(1)
    expect(await torrentWorkers(pageA)).toHaveLength(1)
    expect(await torrentWorkers(pageB)).toHaveLength(0)
    const cloudLeaders = await pageA.evaluate(async () => {
      const snapshot = await navigator.locks.query()
      return snapshot.held?.filter((lock) => lock.name === 'ripple:cloud-backup').length ?? 0
    })
    expect(cloudLeaders).toBe(1)

    await pageA.getByPlaceholder('Add a magnet link').fill(MAGNET)
    await pageA.getByRole('button', { name: 'Add', exact: true }).click()
    await pageB.getByText('Big Buck Bunny', { exact: false }).first().waitFor({ timeout: 30_000 })
    await pageB.getByRole('button', { name: /^(Pause|Resume)$/ }).first().click()
    await pageB.waitForFunction(() => (window as any).__rippleSharedTrace.some((event: TraceEvent) =>
      event.type === 'response' && event.id === 1
    ))

    const rpcA = await trace(pageA)
    const rpcB = await trace(pageB)
    expect(rpcA).toContainEqual(expect.objectContaining({ type: 'request', id: 1, op: 'add-magnet' }))
    expect(rpcA).toContainEqual(expect.objectContaining({ type: 'response', id: 1, ok: true }))
    expect(rpcB).toContainEqual(expect.objectContaining({ type: 'request', id: 1 }))
    expect(rpcB).toContainEqual(expect.objectContaining({ type: 'response', id: 1, ok: true }))

    await pageB.close()
    await pageA.waitForTimeout(2_000)
    const afterNonHostClose = await trace(pageA)
    expect(afterNonHostClose.some((event) => event.topic === 'phase' && event.payload === 'restarting')).toBe(false)
    expect(await torrentWorkers(pageA)).toHaveLength(1)

    const pageC = await context.newPage()
    pageC.on('pageerror', (error) => pageErrors.push(error.message))
    await pageC.goto('/')
    await waitForReady(pageC)
    expect((await welcome(pageC)).coordinatorId).toBe(welcomeA.coordinatorId)
    expect(await torrentWorkers(pageC)).toHaveLength(0)

    await pageA.close()
    await waitForReady(pageC, 2)
    expect(await torrentWorkers(pageC)).toHaveLength(1)
    const replacementTrace = await trace(pageC)
    expect(replacementTrace.filter((event) => event.topic === 'phase' && event.payload === 'restarting')).toHaveLength(1)
    expect(replacementTrace).toContainEqual(expect.objectContaining({ topic: 'phase', payload: 'ready', generation: 2 }))

    await pageC.evaluate(() => {
      ;(window as any).__rippleCoordinatorPort.postMessage({
        kind: 'request',
        id: 9001,
        op: 'pause',
        payload: { handle: 1 },
        engineGeneration: 1,
      })
    })
    await pageC.waitForFunction(() => (window as any).__rippleSharedTrace.some((event: TraceEvent) =>
      event.type === 'response' && event.id === 9001
    ))
    expect(await trace(pageC)).toContainEqual(expect.objectContaining({
      type: 'response',
      id: 9001,
      ok: false,
      error: 'STALE_GENERATION',
      generation: 2,
    }))
    expect(pageErrors).toEqual([])
  } finally {
    await context.close()
  }
})

test('keeps the takeover guard only in dedicated fallback', async ({ browser }) => {
  const context = await browser.newContext()
  try {
    await context.addInitScript((seededKey) => {
      localStorage.setItem(seededKey, '1')
      Object.defineProperty(window, 'SharedWorker', { configurable: true, value: undefined })
    }, DEMO_SEEDED_KEY)
    const pageA = await context.newPage()
    await pageA.goto('/')
    await pageA.getByPlaceholder('Add a magnet link').fill(MAGNET)
    await pageA.getByRole('button', { name: 'Add', exact: true }).click()
    await pageA.getByText('Big Buck Bunny', { exact: false }).first().waitFor({ timeout: 30_000 })

    const pageB = await context.newPage()
    await pageB.goto('/')
    await expect(pageB.getByText('Only one page can be active in this browser.')).toBeVisible()
    await expect(pageA.getByText('Only one page can be active in this browser.')).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('reports an active incompatible runtime before starting an engine', async ({ browser }) => {
  const context = await browser.newContext()
  try {
    await context.addInitScript(() => {
      const channel = new BroadcastChannel('ripple-window-instance-guard')
      channel.addEventListener('message', (event) => {
        if (event.data === 'check') channel.postMessage('active')
        else if (event.data?.type === 'check-shared') {
          channel.postMessage({ type: 'shared-active', protocolVersion: event.data.protocolVersion, buildId: 'older-build' })
        }
      })
      ;(window as any).__legacyRuntimeChannel = channel
    })
    const page = await context.newPage()
    await page.goto('/')
    await expect(page.getByText('Ripple is still running in an older tab.')).toBeVisible()
  } finally {
    await context.close()
  }
})

test('moves same-torrent playback ownership to the latest tab', async ({ browser }) => {
  const context = await browser.newContext()
  try {
    await installTrace(context)
    const pageA = await context.newPage()
    await pageA.goto('/')
    await waitForReady(pageA)
    const pageB = await context.newPage()
    await pageB.goto('/')
    await waitForReady(pageB)

    await pageA.locator('input[type="file"][accept*="bittorrent"]').setInputFiles('src/assets/sintel.torrent')
    await pageB.getByText('Sintel', { exact: false }).first().waitFor({ timeout: 30_000 })
    await pageA.getByRole('link', { name: 'Watch' }).first().click()
    await pageA.waitForURL(/\/embed/)
    await pageA.waitForFunction(() => (window as any).__rippleSharedTrace.some((event: TraceEvent) =>
      event.type === 'worker-created' && event.url?.endsWith('/libav-worker.js')
    ), null, { timeout: 30_000 })
    await pageB.getByRole('link', { name: 'Watch' }).first().click()
    await pageB.waitForURL(/\/embed/)
    await expect(pageA.getByText('Playback moved to another tab')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => pageA.locator('video').evaluate((video) => (video as HTMLVideoElement).paused)).toBe(true)
    await pageA.waitForTimeout(1_000)
    const readsAfterPause = (await trace(pageA)).filter((event) => event.type === 'request' && event.op === 'read').length
    await pageA.waitForTimeout(2_000)
    const readsAfterRevocation = (await trace(pageA)).filter((event) => event.type === 'request' && event.op === 'read').length
    expect(readsAfterRevocation).toBe(readsAfterPause)
  } finally {
    await context.close()
  }
})

test('routes colliding read IDs back to the requesting tab', async ({ browser }) => {
  const context = await browser.newContext()
  try {
    await installTrace(context)
    const pageA = await context.newPage()
    await pageA.goto('/')
    await waitForReady(pageA)
    const pageB = await context.newPage()
    await pageB.goto('/')
    await waitForReady(pageB)

    await pageA.locator('input[type="file"][accept*="bittorrent"]').setInputFiles('src/assets/sintel.torrent')
    await pageA.waitForFunction(() => (window as any).__rippleLatestState?.some((torrent: any) => torrent.files?.files?.length), null, { timeout: 30_000 })
    await pageB.waitForFunction(() => (window as any).__rippleLatestState?.some((torrent: any) => torrent.files?.files?.length), null, { timeout: 30_000 })

    const requestRead = (page: Page, offset: number) => page.evaluate((readOffset) => {
      const state = (window as any).__rippleLatestState as any[]
      const torrent = state.find((item) => item.files?.files?.length)
      const fileIndex = torrent.files.files.reduce((largest: number, file: any, index: number, files: any[]) =>
        file.size > files[largest].size ? index : largest, 0)
      const generation = (window as any).__rippleSharedTrace.findLast((event: TraceEvent) =>
        event.topic === 'phase' && event.payload === 'ready')?.generation
      ;(window as any).__rippleCoordinatorPort.postMessage({
        kind: 'request',
        id: 7001,
        op: 'read',
        payload: {
          handle: torrent.handle,
          infoHash: torrent.infoHash,
          fileIndex,
          offset: readOffset,
          len: 32,
          prioritize: true,
        },
        engineGeneration: generation,
      })
    }, offset)

    await Promise.all([requestRead(pageA, 0), requestRead(pageB, 65_536)])
    await Promise.all([pageA, pageB].map((page) => page.waitForFunction(() =>
      (window as any).__rippleSharedTrace.some((event: TraceEvent) => event.type === 'response' && event.id === 7001),
    null, { timeout: 90_000 })))
    const responseA = (await trace(pageA)).find((event) => event.type === 'response' && event.id === 7001)!
    const responseB = (await trace(pageB)).find((event) => event.type === 'response' && event.id === 7001)!
    expect(responseA).toEqual(expect.objectContaining({ ok: true, bytes: 32 }))
    expect(responseB).toEqual(expect.objectContaining({ ok: true, bytes: 32 }))
    expect(responseA.sample).not.toEqual(responseB.sample)
  } finally {
    await context.close()
  }
})

test('keeps startup requests through the first engine generation', async ({ browser }) => {
  const context = await browser.newContext()
  try {
    await context.route('**/lock-holder', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>lock holder</title>',
    }))
    const blocker = await context.newPage()
    await blocker.goto('/lock-holder')
    await blocker.evaluate(() => {
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      ;(window as any).__releaseEngineLock = release
      void navigator.locks.request('ripple:libtorrent-engine', async () => {
        ;(window as any).__engineLockHeld = true
        await held
      })
    })
    await blocker.waitForFunction(() => (window as any).__engineLockHeld === true)

    await installTrace(context)
    const page = await context.newPage()
    await page.goto('/')
    await page.getByPlaceholder('Add a magnet link').fill(MAGNET)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await blocker.evaluate(() => (window as any).__releaseEngineLock())
    await page.getByText('Big Buck Bunny', { exact: false }).first().waitFor({ timeout: 30_000 })
    expect(await trace(page)).toContainEqual(expect.objectContaining({
      type: 'request',
      id: 1,
      op: 'add-magnet',
      generation: 1,
    }))
  } finally {
    await context.close()
  }
})

test('retries the same host after an engine startup failure', async ({ browser }) => {
  const context = await browser.newContext()
  try {
    await installTrace(context)
    await context.addInitScript(() => { (window as any).__failFirstTorrentWorker = true })
    const page = await context.newPage()
    await page.goto('/')
    await waitForReady(page, 2)
    expect(await torrentWorkers(page)).toHaveLength(1)
    expect(await trace(page)).toContainEqual(expect.objectContaining({
      topic: 'phase',
      payload: 'ready',
      generation: 2,
    }))
  } finally {
    await context.close()
  }
})

test('recovers the shared coordinator after a legacy takeover closes', async ({ browser }) => {
  const context = await browser.newContext()
  try {
    await installTrace(context)
    const page = await context.newPage()
    await page.goto('/')
    await waitForReady(page)

    await context.route('**/legacy-holder', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>legacy holder</title>',
    }))
    const legacy = await context.newPage()
    await legacy.goto('/legacy-holder')
    await legacy.evaluate(() => {
      const channel = new BroadcastChannel('ripple-window-instance-guard')
      channel.addEventListener('message', (event) => {
        if (event.data === 'check') channel.postMessage('active')
      })
      ;(window as any).__legacyChannel = channel
      channel.postMessage('activate')
    })
    await page.waitForFunction(() => (window as any).__rippleSharedTrace.some((event: TraceEvent) =>
      event.topic === 'phase' && event.payload === 'restarting'
    ))
    await legacy.close()
    await waitForReady(page, 2)
  } finally {
    await context.close()
  }
})

test('imports every file from a multiple torrent selection', async ({ browser }) => {
  const context = await browser.newContext()
  try {
    await installTrace(context)
    const page = await context.newPage()
    await page.goto('/')
    await waitForReady(page)
    const bytes = await readFile('src/assets/sintel.torrent')
    await page.locator('input[type="file"][accept*="bittorrent"]').setInputFiles([
      { name: 'sintel-one.torrent', mimeType: 'application/x-bittorrent', buffer: bytes },
      { name: 'sintel-two.torrent', mimeType: 'application/x-bittorrent', buffer: bytes },
    ])
    await page.waitForFunction(() => (window as any).__rippleSharedTrace.filter((event: TraceEvent) =>
      event.type === 'request' && event.op === 'add-torrent-file').length === 2,
    null, { timeout: 30_000 })
  } finally {
    await context.close()
  }
})
