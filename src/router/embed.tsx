import type { DownloadedRange } from '@banou/media-player/src/utils/context'

import { useEffect, useMemo, useState, useRef } from 'react'
import { css } from '@emotion/react'
import { useSearchParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, User } from 'react-feather'

import MediaPlayer from '@banou/media-player'

import { getBytesRangesFromPieces } from '../utils/downloaded-ranges'
import { getHumanReadableByteString } from '../utils/bytes'
import { useEngine } from '../hooks/use-engine'
import { useTorrent } from '../hooks/use-torrent'
import { TooltipDisplay } from '../components/tooltip-display'

const playerStyle = css`
height: 100%;
width: 100%;
overflow-x: hidden;
& > div {
  height: 100%;
  width: 100%;
  & > video, & > div {
    height: 100vh;
    max-height: 100%;
    width: 100vw;
    max-width: 100%;
  }
}

grid-column: 1;
grid-row: 1;

div canvas {
  margin: auto;
}

.player-overlay {
  display: flex;
  justify-content: space-between;
  align-items: start;
  grid-column: 1;
  grid-row: 1;
  & > div, & > a {
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 3rem;
    font-weight: bold;
    cursor: pointer;
    & > svg { margin-right: 1rem; }
    text-decoration: none;
    margin: 1.5rem;
    padding: 1rem;
    position: relative;
    background: radial-gradient(ellipse at center, rgba(0,0,0,0.4) 0%,rgba(0,0,0,0.1) calc(100% - 1rem),rgba(0,0,0,0) 100%);
  }
}

.hide { .player-overlay { display: none; } }

.media-information {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 8px 12px;
  font-weight: 400; font-size: 1.2rem; line-height: 1.7rem;
  @media (min-width: 960px) { font-size: 1.4rem; line-height: 2rem; }
  text-shadow: 0 0 4px rgba(0, 0, 0, 1);
  margin-right: 8px;
  @media (min-width: 768px)  { margin-right: 12px; }
  @media (min-width: 2560px) { margin-right: 16px; }
  .item { display: flex; align-items: center; gap: 4px; }
}
`

const BASE_BUFFER_SIZE = 2_500_000

const Player = () => {
  const engine = useEngine()
  const [searchParams] = useSearchParams()

  const { magnet: rawMagnet, fileIndex: rawFileIndex } = Object.fromEntries(searchParams.entries())
  const magnet    = useMemo(() => rawMagnet ? atob(rawMagnet) : undefined, [rawMagnet])
  const fileIndex = useMemo(() => Number(rawFileIndex || 0), [rawFileIndex])

  const { infoHash, files, status, loading } = useTorrent({ magnet, fileIndex })
  const selectedFile = files?.[fileIndex]
  const fileSize = selectedFile?.length

  // Track downloaded pieces from the engine alert stream so we can render
  // the seek bar's progress segments. libtorrent emits piece_finished as
  // pieces complete; we accumulate into a Set and recompute byte ranges.
  const [donePieces, setDonePieces] = useState<Set<number>>(new Set())
  const pieceLengthRef = useRef<number>(0)
  const torrentLengthRef = useRef<number>(0)

  useEffect(() => {
    if (!infoHash) return
    let unsub: (() => Promise<void>) | undefined
    let cancelled = false
    ;(async () => {
      unsub = await engine.subscribe(alert => {
        if (cancelled) return
        if (alert.type === 'piece_finished' && alert.infoHash === infoHash) {
          setDonePieces(prev => {
            if (prev.has(alert.piece)) return prev
            const next = new Set(prev); next.add(alert.piece); return next
          })
        }
      })
    })()
    return () => { cancelled = true; if (unsub) unsub().catch(() => {}) }
  }, [engine, infoHash])

  // Asset URLs: shipped flat at site root in production, /build/ in dev.
  const publicPath = useMemo(
    () => new URL(import.meta.env.DEV ? '/build/' : '/', window.location.origin).toString(),
    []
  )
  const assetUrl = (name: string) =>
    new URL(`${import.meta.env.DEV ? '/build' : ''}/${name}`, window.location.origin).toString()

  const jassubWorkerUrl = useMemo(() => {
    const u = assetUrl('jassub-worker.js')
    const blob = new Blob([`importScripts(${JSON.stringify(u)})`], { type: 'application/javascript' })
    return URL.createObjectURL(blob)
  }, [])

  const libavWorkerUrl = useMemo(() => {
    const u = assetUrl('libav-worker.js')
    const blob = new Blob([`importScripts(${JSON.stringify(u)})`], { type: 'application/javascript' })
    return URL.createObjectURL(blob)
  }, [])

  const jassubWasmUrl       = useMemo(() => assetUrl('jassub-worker.wasm'), [])
  const jassubModernWasmUrl = useMemo(() => assetUrl('jassub-worker-modern.wasm'), [])

  // Streaming read: hand the player a function that pulls bytes via the
  // engine. We bias the picker toward the upcoming bytes via readahead.
  const read = useMemo(() => async (offset: number, size: number) => {
    if (!infoHash || !selectedFile) throw new Error('torrent not ready')
    // Push an 8-chunk readahead window from the current offset. anacrolix's
    // Reader uses this to raise piece priorities to "Now".
    try { await engine.readahead(infoHash, fileIndex, offset, size * 8) } catch {}
    const data = await engine.read(infoHash, fileIndex, offset, size)
    // Always return a fresh ArrayBuffer (not SharedArrayBuffer) — the
    // media player expects the non-shared variant.
    const out = new ArrayBuffer(data.byteLength)
    new Uint8Array(out).set(data)
    return out
  }, [engine, infoHash, selectedFile, fileIndex, status?.totalWanted])

  // Seek bar: recompute on a slow timer so we don't thrash on rapid alerts.
  const [downloadedRanges, setDownloadedRanges] = useState<DownloadedRange[]>([])
  useEffect(() => {
    if (!selectedFile || pieceLengthRef.current === 0 || torrentLengthRef.current === 0) {
      setDownloadedRanges([])
      return
    }
    const tick = () => setDownloadedRanges(
      getBytesRangesFromPieces(
        donePieces,
        pieceLengthRef.current,
        torrentLengthRef.current,
        0, // libtorrent's "file offset within torrent" is in our FileInfo; populate when we surface it
        selectedFile.length
      )
    )
    tick()
    const i = setInterval(tick, 1000)
    return () => clearInterval(i)
  }, [donePieces, selectedFile])

  const mediaInformation = useMemo(() => {
    if (!status) return undefined
    return (
      <div className='media-information'>
        <TooltipDisplay
          id='peers'
          text={<div className='item'><User /><span>{status.numPeers}</span></div>}
          toolTipText={<span>Peers: {status.numPeers} <br/>Connected to swarm</span>}
        />
        <TooltipDisplay
          id='download-speed'
          text={<div className='item'><ArrowDown /><span>{getHumanReadableByteString(status.downloadRate, true)}/s</span></div>}
          toolTipText={<span>Download: {getHumanReadableByteString(status.downloadRate)}/s</span>}
        />
        <TooltipDisplay
          id='upload-speed'
          text={<div className='item'><ArrowUp /><span>{getHumanReadableByteString(status.uploadRate, true)}/s</span></div>}
          toolTipText={<span>Upload: {getHumanReadableByteString(status.uploadRate)}/s</span>}
        />
      </div>
    )
  }, [status])

  const loadingInformation = useMemo(() => {
    if (loading)              return <div>Loading torrent…</div>
    if (!status)              return <div>Connecting to swarm…</div>
    if (!files || !files.length) return <div>Waiting for metadata…</div>
    return <div>Downloaded {getHumanReadableByteString(status.totalWantedDone)}</div>
  }, [loading, status, files])

  return (
    <div css={playerStyle}>
      <MediaPlayer
        title={selectedFile?.path}
        bufferSize={BASE_BUFFER_SIZE}
        read={read}
        size={fileSize}
        downloadedRanges={downloadedRanges}
        autoplay={true}
        loadingInformation={loadingInformation}
        mediaInformation={mediaInformation}
        publicPath={publicPath}
        libavWorkerUrl={libavWorkerUrl}
        jassubWasmUrl={jassubWasmUrl}
        jassubWorkerUrl={jassubWorkerUrl}
        jassubModernWasmUrl={jassubModernWasmUrl}
      />
    </div>
  )
}

export default Player
