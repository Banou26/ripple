import { createContext, useContext } from 'react'
import type { EngineClient } from '../worker/client'

export const EngineContext = createContext<EngineClient | null>(null)

export const useEngine = (): EngineClient => {
  const e = useContext(EngineContext)
  if (!e) throw new Error('useEngine must be used inside <EngineContext.Provider>')
  return e
}
