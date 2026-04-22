// Mount: top-level provider. The previous implementation enforced a single
// active tab via BroadcastChannel because webtorrent + OPFS couldn't share
// state across tabs. With the new SharedWorker engine, that's gone — every
// tab attaches to the same worker and the worker owns OPFS and the session.

import { useMemo } from 'react'

import Router from '../router'
import { EngineContext } from '../hooks/use-engine'
import { getEngineClient } from '../worker/client'

const Mount = () => {
  const engine = useMemo(() => getEngineClient(), [])
  return (
    <EngineContext.Provider value={engine}>
      <Router/>
    </EngineContext.Provider>
  )
}

export default Mount
