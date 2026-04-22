// React state mirror of the engine's torrent list. Subscribes to alerts and
// re-fetches the list when membership changes; polls status on a slow
// interval for rate/progress updates so we don't post a `list` for every
// state_update alert.

import { useEffect, useState } from 'react'

import { useEngine } from './use-engine'
import type { ListItem } from '../worker/rpc'

export const useTorrents = () => {
  const engine = useEngine()
  const [items, setItems] = useState<ListItem[]>([])

  useEffect(() => {
    let cancelled = false

    const refresh = async () => {
      const list = await engine.list()
      if (!cancelled) setItems(list)
    }

    refresh()

    const unsubPromise = engine.subscribe((alert) => {
      if (alert.type === 'torrent_added' || alert.type === 'torrent_removed' || alert.type === 'metadata_received') {
        refresh()
      } else if (alert.type === 'state_update') {
        // Cheap in-place merge — avoids hitting the worker for every tick.
        setItems(prev => prev.map(it => {
          const upd = alert.torrents.find(t => t.infoHash === it.infoHash)
          if (!upd) return it
          return { ...it, status: { ...it.status, ...upd } }
        }))
      }
    })

    const interval = setInterval(refresh, 5000)

    return () => {
      cancelled = true
      clearInterval(interval)
      unsubPromise.then(fn => fn())
    }
  }, [engine])

  return items
}
