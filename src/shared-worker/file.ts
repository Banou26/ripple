import type { Resolvers } from '../worker'
import type { TorrentDocument } from '../database'

import { assign, createMachine, fromObservable, sendParent } from 'xstate'
import { call } from 'osra'
import { Observable } from 'rxjs'
import { torrent } from '@fkn/lib'

import { getIoWorkerPort } from './io-worker'
import { mergeRanges, throttleStream } from './utils'
import { RxDocument } from 'rxdb'

const BYTES_PER_SECOND_TIME_RANGE = 10_000

export const fileMachine = createMachine({
  initial: 'checkingFile',
  context: (
    { input }:
    { input: { document: TorrentDocument, file: NonNullable<TorrentDocument['state']['files']>[number] } }
  ) => ({
    document: input.document,
    file: input.file as NonNullable<TorrentDocument['state']['files']>[number],
    downloadedRanges: input.file.downloadedRanges ?? [],
    downloaded: input.file.downloaded ?? 0,
    progress: input.file.progress ?? 0,
    selected: input.file.selected ?? false,
    priority: input.file.priority ?? 0,
    length: input.file.length ?? 0,
    offset: input.file.offset ?? 0,
    path: input.file.path ?? '',
    name: input.file.name ?? '',
    index: input.file.index ?? 0,
    status: input.file.status ?? 'checking',
    streamBandwithLogs: input.file.streamBandwithLogs ?? [],
    bytesPerSecond: input.file.bytesPerSecond ?? 0
  }),
  on: {
    'FILE.PAUSE': {
      target: '.paused'
    },
    'FILE.RESUME': {
      target: '.downloading'
    }
  },
  // invoke: [
  //   {
  //     id: 'syncDBState',
  //     src: fromObservable(({ context, self, ...rest }) => {
  //       const pause$ =
  //         from(self)
  //           .pipe(
  //             filter((event) => event.type === 'FILE.PAUSE'),
  //             tap(() => {
  //               context.document.incrementalModify((doc) => {
  //                 const file = doc.state.files.find((file) => file.path === context.file.path)
  //                 if (!file) return doc
  //                 file.status = 'paused'
  //                 return doc
  //               })
  //             })
  //           )

  //       const resume$ =
  //         from(self)
  //           .pipe(
  //             filter((event) => event.type === 'FILE.RESUME'),
  //             tap((event) => {
  //               context.document.incrementalModify((doc) => {
  //                 const file = doc.state.files.find((file) => file.path === context.file.path)
  //                 if (!file) return doc
  //                 // file.status = 'downloading'
  //                 return doc
  //               })
  //             })
  //           )

  //       return (
  //         merge(
  //           pause$,
  //           resume$
  //         )
  //       )
  //     })
  //   }
  // ],
  states: {
    checkingFile: {
      entry: sendParent({ type: 'FILE.CHECKING_FILE' }),
      always: {
        target: 'downloading',
        guard: ({ context }) => context?.selected === true
      }
    },
    downloading: {
      entry: sendParent({ type: 'FILE.DOWNLOADING' }),
      invoke: {
        input: ({ context }) => context,
        src:
          fromObservable((ctx) =>
            new Observable(observer => {
              const document = ctx.input.document as RxDocument<TorrentDocument>

              if (ctx.input.file.selected === false) {
                return observer.complete()
              }

              const lastRange =
                ctx
                  .input
                  .file
                  .downloadedRanges
                  .sort((a, b) => a.start - b.start)
                  .at(0)

              const offsetStart = lastRange?.end || 0

              if (offsetStart === ctx.input.file.length) {
                observer.complete()
                return
              }

              let streamBandwithLogs = [...ctx.input.streamBandwithLogs]
              let downloadedRanges = [...ctx.input.file.downloadedRanges.map((range) => ({ ...range }))]

              let cancelled = false
              let _resolve, _reject
              let closePromise = new Promise<() => Promise<void> | undefined>((resolve, reject) => {
                _resolve = resolve
                _reject = reject
              })
              torrent({
                magnet: document.state.magnet,
                path: ctx.input.file.path,
                offset: offsetStart
              }).then(async (res: Response) => {
                const throttledResponse = throttleStream(res.body!, 1_000_000)
                const reader = throttledResponse.getReader() as ReadableStreamReader<Uint8Array>
                
                const { write, close } = await call<Resolvers>(getIoWorkerPort(), { key: 'io-worker' })(
                  'openWriteStream',
                  {
                    filePath: `torrents/${ctx.input.document.infoHash}/${ctx.input.file.path}`,
                    offset: offsetStart,
                    size: ctx.input.file.length
                  }
                )

                _resolve(close)

                const read = async () => {
                  if (cancelled) {
                    await reader.cancel()
                    await close()
                    return
                  }
                  const { done, value } = await reader.read()
                  if (done) {
                    await close()
                    observer.complete()
                    return
                  }
                  const bufferLength = value.byteLength
                  await write(value.buffer)

                  const downloadRange =
                    downloadedRanges
                      ?.find((range) => range.start <= offsetStart && range.end >= offsetStart)
                  if (downloadRange) {
                    downloadRange.end = downloadRange.end + bufferLength
                  } else {
                    downloadedRanges = [
                      ...downloadedRanges,
                      { start: offsetStart, end: offsetStart + bufferLength }
                    ]
                  }

                  downloadedRanges = mergeRanges(downloadedRanges)

                  streamBandwithLogs = [
                    ...streamBandwithLogs,
                    { timestamp: Date.now(), byteLength: bufferLength }
                  ]

                  const bytesPerSecondList =
                    streamBandwithLogs
                      .filter((log) => log.timestamp > (Date.now() - BYTES_PER_SECOND_TIME_RANGE))
                      .sort((a, b) => a.timestamp - b.timestamp)

                  const downloaded = downloadedRanges.reduce((acc, range) => acc + (range.end - range.start), 0)

                  const bytesPerSecond =
                    bytesPerSecondList.reduce((acc, log) => acc + log.byteLength, 0)
                    / BYTES_PER_SECOND_TIME_RANGE
                    * 1000

                  observer.next({
                    type: 'FILE.DOWNLOADING_UPDATE',
                    value: {
                      downloadedRanges,
                      downloaded,
                      progress: downloaded / ctx.input.file.length,
                      status: 'downloading',
                      streamBandwithLogs: [...streamBandwithLogs],
                      bytesPerSecond
                    }
                  })
                  if (!cancelled) read()
                }
                read()
              }).catch((err) => {
                _resolve(undefined)
                console.log('downloadFile err', err)
                observer.error(err)
              })

              return () => {
                cancelled = true
                closePromise.then((close) => close?.())
              }
            })
          ),
        onSnapshot: {
          guard: ({ event }) => event.snapshot.context?.type === 'FILE.DOWNLOADING_UPDATE',
          actions: assign(({ event }) => ({
            downloadedRanges: event.snapshot.context.value.downloadedRanges,
            downloaded: event.snapshot.context.value.downloaded,
            progress: event.snapshot.context.value.progress,
            status: event.snapshot.context.value.status,
            streamBandwithLogs: event.snapshot.context.value.streamBandwithLogs,
            bytesPerSecond: event.snapshot.context.value.bytesPerSecond
          }))
        },
        onDone: {
          target: 'finished'
        }
      },
      on: {
        'FILE.PAUSE': {
          target: 'paused',
          actions: assign({
            status: 'paused'
          })
        }
      }
    },
    paused: {
      entry: [
        sendParent({ type: 'FILE.PAUSED' }),
        assign({
          status: 'paused'
        })
      ],
      on: {
        'FILE.RESUME': {
          target: 'downloading',
          actions: assign({
            status: 'downloading'
          })
        }
      }
    },
    finished: {
      entry: [
        sendParent({ type: 'FILE.FINISHED' }),
        assign({
          status: 'finished',
          downloaded: ({ context }) => context.length,
          progress: 1,
          downloadedRanges: ({ context }) => [{ start: 0, end: context.length }]
        })
      ]
    }
  }
})

export type FileMachine = typeof fileMachine
