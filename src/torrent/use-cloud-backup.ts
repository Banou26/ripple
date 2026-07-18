import type { Persisted, TorrentClient } from './client'

import { useEffect, useState } from 'react'

import { account, cloud } from '@fkn/lib'

import { DEMO_SEEDED_KEY } from './constants'

export const BACKUP_PATH = 'ripple/torrents.json'
const ACCOUNT_KEY = 'ripple:sync-account'
const LEADER_LOCK = 'ripple:cloud-backup'
const WRITE_DEBOUNCE = 3_000
const RESTORE_RETRY = 5_000
const MAX_RESTORE_ATTEMPTS = 4

export type SyncStatus = 'off' | 'syncing' | 'synced' | 'error'

let settle: () => void
export const cloudRestoreSettled = new Promise<void>((resolve) => { settle = resolve })

const accountName = (): Promise<string | null> =>
  Promise.race([
    account.info().then((value) => value?.name ?? null),
    new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 4_000)),
  ]).catch(() => null)

export const useCloudBackup = (clientRef: { current: TorrentClient | null }): SyncStatus => {
  const [status, setStatus] = useState<SyncStatus>('off')

  useEffect(() => {
    const client = clientRef.current
    if (!client) { settle(); return }

    const leaderAbort = new AbortController()
    let releaseLeader: (() => void) | undefined
    let cleanupLeader: (() => Promise<void>) | undefined

    const runLeader = async () => {
      if (leaderAbort.signal.aborted) return
      let cancelled = false
      let connected = false
      let restored = false
      let pending = false
      let latest: Persisted[] = []
      let timer: number | undefined
      let restoreTimer: number | undefined

      const writeNow = () => {
        pending = false
        window.clearTimeout(timer)
        const portable = latest.map((entry) => ({
          infoHash: entry.infoHash,
          magnet: entry.magnet,
          savePath: entry.savePath,
          addedAt: entry.addedAt,
        }))
        return cloud.fs.promises.writeFile(BACKUP_PATH, JSON.stringify(portable), { contentType: 'application/json' })
      }
      const write = async () => {
        if (cancelled || !connected || !restored) return
        setStatus('syncing')
        try { await writeNow(); if (!cancelled) setStatus('synced') }
        catch { if (!cancelled) setStatus('error') }
      }
      const schedule = () => {
        pending = true
        window.clearTimeout(timer)
        timer = window.setTimeout(write, WRITE_DEBOUNCE)
      }
      const flush = async () => {
        if (pending && connected && restored) await writeNow()
      }
      const onPageHide = () => { void flush().catch(() => {}) }
      const offList = client.onList((list) => { latest = list; if (connected) schedule() })

      const restore = async (attempt = 0) => {
        const retry = () => {
          setStatus('error')
          if (attempt >= MAX_RESTORE_ATTEMPTS) return
          window.clearTimeout(restoreTimer)
          restoreTimer = window.setTimeout(() => { void restore(attempt + 1) }, RESTORE_RETRY)
        }
        restored = false
        pending = false
        window.clearTimeout(timer)
        let ok = false
        try { ok = await cloud.fs.available() } catch {}
        if (cancelled) return
        connected = ok
        if (!ok) { setStatus('off'); return }

        const name = await accountName()
        if (cancelled) return
        if (name) {
          let previous: string | null = null
          try { previous = localStorage.getItem(ACCOUNT_KEY) } catch {}
          if (previous && previous !== name) {
            try { await client.clearList(); latest = [] } catch { retry(); return }
          }
          try { localStorage.setItem(ACCOUNT_KEY, name) } catch {}
        }

        setStatus('syncing')
        let text: string | null = null
        let missing = false
        try {
          text = String(await cloud.fs.promises.readFile(BACKUP_PATH, 'utf8'))
        } catch (error) {
          missing = /not found/i.test((error as { message?: string })?.message ?? '')
        }
        if (cancelled) return

        if (text !== null) {
          let list: unknown
          try { list = JSON.parse(text) } catch {}
          if (Array.isArray(list)) {
            try { localStorage.setItem(DEMO_SEEDED_KEY, '1') } catch {}
            if (list.length) {
              try { await client.importList(list) } catch { retry(); return }
            }
          }
          restored = true
          setStatus('synced')
        } else if (missing) {
          restored = true
          setStatus('synced')
          if (latest.length) schedule()
        } else {
          retry()
        }
      }

      let offAccount: (() => void) | undefined
      void account.onChange(() => { if (!cancelled) void restore() })
        .then((off) => { if (cancelled) off(); else offAccount = off })
        .catch(() => {})
      void restore().finally(() => settle())
      window.addEventListener('pagehide', onPageHide)

      let cleanupPromise: Promise<void> | undefined
      cleanupLeader = () => cleanupPromise ??= (async () => {
        if (cancelled) return
        const shouldFlush = pending && connected && restored
        cancelled = true
        window.removeEventListener('pagehide', onPageHide)
        window.clearTimeout(timer)
        window.clearTimeout(restoreTimer)
        offList()
        offAccount?.()
        if (shouldFlush) await writeNow().catch(() => {})
      })()

      await new Promise<void>((resolve) => { releaseLeader = resolve })
      await cleanupLeader()
    }

    const start = async () => {
      if (navigator.locks) {
        try {
          await navigator.locks.request(LEADER_LOCK, { signal: leaderAbort.signal }, runLeader)
        } catch (error: any) {
          if (error?.name !== 'AbortError') setStatus('error')
        }
      } else {
        await runLeader()
      }
    }
    void start()

    return () => {
      leaderAbort.abort()
      if (cleanupLeader) void cleanupLeader()
      releaseLeader?.()
    }
  }, [clientRef])

  return status
}
