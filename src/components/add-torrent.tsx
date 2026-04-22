// Add-torrent surface used in HOME and the file/protocol handler routes.
// Accepts a magnet URI in a text input, or a .torrent file via dropzone.

import { useState, useCallback } from 'react'
import { css } from '@emotion/react'
import { useDropzone } from 'react-dropzone'

import { useEngine } from '../hooks/use-engine'
import { putTorrent } from '../store/torrents-db'

const style = css`
  display: flex; flex-direction: column; gap: 1rem;
  padding: 1.6rem; border: 1px solid #2a2a2a; border-radius: 0.6rem;
  background: #141414;

  .dropzone {
    border: 2px dashed #333; border-radius: 0.6rem;
    padding: 2.4rem; text-align: center; cursor: pointer;
    color: #aaa;
    transition: border-color 0.15s ease, color 0.15s ease;
  }
  .dropzone.active { border-color: #888; color: #fff; }

  input[type=text] {
    background: #0f0f0f; border: 1px solid #2a2a2a; color: #fff;
    border-radius: 0.4rem; padding: 0.8rem 1.2rem; font: inherit;
  }
  button {
    background: #2a2a2a; color: #fff; border: 0; padding: 0.8rem 1.6rem;
    border-radius: 0.4rem; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .row { display: flex; gap: 0.8rem; }
  .row input { flex: 1; }
  .error { color: #ff6f6f; font-size: 1.3rem; }
`

export type AddTorrentProps = {
  onAdded?: (infoHash: string) => void
}

const AddTorrent = ({ onAdded }: AddTorrentProps) => {
  const engine = useEngine()
  const [magnet, setMagnet] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const submit = useCallback(async (input: string | Uint8Array, source: 'magnet' | 'file', src: string | ArrayBuffer) => {
    setBusy(true); setError(undefined)
    try {
      const infoHash = await engine.add(input)
      await putTorrent({
        infoHash,
        name: typeof src === 'string' ? src : 'torrent file',
        source: source === 'magnet'
          ? { kind: 'magnet', uri: src as string }
          : { kind: 'file',   bytes: src as ArrayBuffer },
        addedAt: Date.now()
      })
      onAdded?.(infoHash)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [engine, onAdded])

  const onDrop = useCallback(async (files: File[]) => {
    const f = files[0]; if (!f) return
    const buf = await f.arrayBuffer()
    await submit(new Uint8Array(buf), 'file', buf)
  }, [submit])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
    accept: { 'application/x-bittorrent': ['.torrent'] }
  })

  return (
    <div css={style}>
      <div className='row'>
        <input
          type='text'
          placeholder='magnet:?xt=urn:btih:…'
          value={magnet}
          onChange={(e) => setMagnet(e.target.value)}
          disabled={busy}
        />
        <button
          disabled={busy || !magnet.startsWith('magnet:')}
          onClick={() => submit(magnet, 'magnet', magnet)}
        >Add</button>
      </div>
      <div {...getRootProps()} className={`dropzone ${isDragActive ? 'active' : ''}`}>
        <input {...getInputProps()} />
        Drop a .torrent file here, or click to choose
      </div>
      {error && <div className='error'>{error}</div>}
    </div>
  )
}

export default AddTorrent
