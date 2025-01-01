import { Instance } from "parse-torrent-file"

export const getTorrentFilePieces = (torrentFile: Instance, fileIndex: number) => {
  if (
    !torrentFile.files
    || torrentFile.pieces === undefined
    || torrentFile.pieceLength === undefined
  ) {
    throw new Error('torrentFile missing files, pieces or pieceLength')
  }

  const filesByteRanges =
    torrentFile.files.reduce(
      (fileRanges, file, index) => [
        ...fileRanges,
        {
          index,
          start: fileRanges.at(-1)?.end ?? 0,
          end: file.length + (fileRanges.at(-1)?.end ?? 0),
        }
      ],
      [] as { index: number, start: number, end: number }[]
    )

  const filePieceRanges =
    filesByteRanges.reduce(
      (piecesRanges, fileByteRange) => {
        const piecesCount = Math.ceil(fileByteRange.end / torrentFile.pieceLength!)
        
        return [
          ...piecesRanges,
          {
            ...fileByteRange,
            startPieceIndex: Math.round(fileByteRange.start / torrentFile.pieceLength!),
            isStartPieceMultiFile: !Number.isInteger(fileByteRange.start / torrentFile.pieceLength!),
            endPieceIndex:
              piecesCount >= torrentFile.pieces!.length - 1
                ? torrentFile.pieces!.length - 1
                : piecesCount,
            isEndPieceMultiFile:
              !Number.isInteger(
                piecesCount >= torrentFile.pieces!.length - 1
                  ? torrentFile.pieces!.length - 1
                  : piecesCount
              )
          }
        ]
      },
      [] as {
        index: number
        start: number
        end: number
        startPieceIndex: number
        endPieceIndex: number
        isStartPieceMultiFile: boolean
        isEndPieceMultiFile: boolean
      }[]
    )

  return filePieceRanges[fileIndex]!
}
