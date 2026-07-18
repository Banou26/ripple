import type { ReactNode } from 'react'
import type { RuntimeMode, TorrentClient } from './client'

import { createContext, useContext, useEffect, useState } from 'react'

import { createTorrentClient } from './client'
import { PROTOCOL_VERSION } from './protocol'

export type RuntimeSelection = RuntimeMode | 'legacy-conflict'

const RuntimeContext = createContext<TorrentClient | null>(null)

const checkLegacyRuntime = (): Promise<'none' | 'shared' | 'dedicated' | 'legacy'> =>
  new Promise((resolve) => {
    const channel = new BroadcastChannel('ripple-window-instance-guard')
    let activeCount = 0
    let currentDedicated = false
    let shared = false
    let foreign = false
    const finish = () => {
      channel.close()
      if (foreign || activeCount > 1) resolve('legacy')
      else if (shared) resolve('shared')
      else if (currentDedicated) resolve('dedicated')
      else if (activeCount > 0) resolve('legacy')
      else resolve('none')
    }
    channel.addEventListener('message', (event) => {
      if (event.data === 'active' || event.data === 'activate') activeCount++
      else if (event.data?.type === 'active') {
        if (event.data.buildId === __COMMIT_HASH__) currentDedicated = true
        else foreign = true
      } else if (event.data?.type === 'shared-active') {
        if (event.data.protocolVersion === PROTOCOL_VERSION && event.data.buildId === __COMMIT_HASH__) shared = true
        else foreign = true
      }
    })
    channel.postMessage('check')
    channel.postMessage({ type: 'check-active', buildId: __COMMIT_HASH__ })
    channel.postMessage({ type: 'check-shared', protocolVersion: PROTOCOL_VERSION, buildId: __COMMIT_HASH__ })
    setTimeout(finish, 75)
  })

const probeSharedCoordinator = (): Promise<boolean> =>
  new Promise((resolve) => {
    try {
      const worker = new SharedWorker(new URL('./shared-worker-probe.ts', import.meta.url), {
        type: 'module',
        name: `ripple-torrent-probe-v${PROTOCOL_VERSION}`,
      })
      const timer = setTimeout(() => { worker.port.close(); resolve(false) }, 3_000)
      worker.port.addEventListener('message', (event) => {
        clearTimeout(timer)
        worker.port.close()
        resolve(event.data === true)
      }, { once: true })
      worker.addEventListener('error', () => {
        clearTimeout(timer)
        worker.port.close()
        resolve(false)
      }, { once: true })
      worker.port.start()
    } catch {
      resolve(false)
    }
  })

export const selectTorrentRuntime = async (): Promise<RuntimeSelection> => {
  if (typeof SharedWorker === 'undefined' || typeof Worker === 'undefined' || !navigator.locks) return 'dedicated'
  const existing = await checkLegacyRuntime()
  if (existing === 'legacy') return 'legacy-conflict'
  if (existing === 'dedicated') return 'dedicated'
  if (!(await probeSharedCoordinator())) return 'dedicated'
  const finalCheck = await checkLegacyRuntime()
  if (finalCheck === 'legacy') return 'legacy-conflict'
  return finalCheck === 'dedicated' ? 'dedicated' : 'shared'
}

export const TorrentRuntimeProvider = ({ mode, children }: { mode: RuntimeMode, children: ReactNode }) => {
  const [client] = useState(() => createTorrentClient(mode))
  useEffect(() => () => client.destroy(), [client])
  return <RuntimeContext.Provider value={client}>{children}</RuntimeContext.Provider>
}

export const useTorrentClient = (): TorrentClient => {
  const client = useContext(RuntimeContext)
  if (!client) throw new Error('TorrentRuntimeProvider is missing')
  return client
}
