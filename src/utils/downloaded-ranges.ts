import type { DownloadedRange } from '@banou/media-player/src/utils/context'

// Translate a set of completed piece indices into byte ranges within a
// single file. The libtorrent engine surfaces piece completion via
// `piece_finished` alerts (see src/engine/alerts.ts); the player consumer
// accumulates them into a Set and feeds it here every render tick.

export const getBytesRangesFromPieces = (
  donePieces: ReadonlySet<number>,
  pieceLength: number,
  torrentLength: number,
  fileOffset: number,
  fileLength: number
): DownloadedRange[] => {
  const ranges: DownloadedRange[] = []
  if (fileLength === 0 || pieceLength === 0) return ranges

  const fileEnd = fileOffset + fileLength
  const firstPiece = Math.floor(fileOffset / pieceLength)
  const lastPiece  = Math.ceil(fileEnd / pieceLength) - 1
  const numPieces  = Math.ceil(torrentLength / pieceLength)

  const flush = (startPiece: number, endPiece: number) => {
    const absStart = startPiece * pieceLength
    const absEnd   = Math.min(endPiece * pieceLength, torrentLength)
    if (absStart >= fileEnd || absEnd <= fileOffset) return
    ranges.push({
      startByteOffset: Math.max(absStart, fileOffset) - fileOffset,
      endByteOffset:   Math.min(absEnd, fileEnd)      - fileOffset
    })
  }

  let runStart = -1
  const upTo = Math.min(lastPiece + 1, numPieces)
  for (let i = firstPiece; i <= upTo; i++) {
    const have = donePieces.has(i)
    if (have && runStart === -1) runStart = i
    else if ((!have || i === upTo) && runStart !== -1) {
      flush(runStart, i)
      runStart = -1
    }
  }
  return ranges
}
