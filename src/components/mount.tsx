import type { RuntimeMode } from '../torrent/client'

import { css } from '@emotion/react'
import { useEffect, useState } from 'react'

import Router from '../router'
import { selectTorrentRuntime, TorrentRuntimeProvider } from '../torrent/runtime'
import { useActiveWindow } from '../utils/active-window-effect'

const style = css`
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  height: 100%;
  width: 100%;

  & > div {
    margin: 1rem;
  }
`

const RuntimeApp = ({ mode }: { mode: RuntimeMode }) => (
  <TorrentRuntimeProvider mode={mode}>
    <Router/>
  </TorrentRuntimeProvider>
)

const GuardedApp = () => {
  const { isActive, activate } = useActiveWindow({})

  if (!isActive) {
    return (
      <div css={style}>
        <div>Only one page can be active in this browser.</div>
        <div>Do you want this tab/window to take over? It will stop the other tab/window.</div>
        <div><button onClick={activate}>Yes, take over</button></div>
      </div>
    )
  }

  return <RuntimeApp mode="dedicated"/>
}

const Mount = () => {
  const [selection, setSelection] = useState<Awaited<ReturnType<typeof selectTorrentRuntime>>>()
  useEffect(() => { void selectTorrentRuntime().then(setSelection) }, [])

  if (!selection) return <div css={style}><div>Starting Ripple...</div></div>
  if (selection === 'shared') return <RuntimeApp mode="shared"/>
  if (selection === 'dedicated') return <GuardedApp/>
  return (
    <div css={style}>
      <div>Ripple is still running in an older tab.</div>
      <div>Close or reload the older tab, then reload this page.</div>
    </div>
  )
}

export default Mount
