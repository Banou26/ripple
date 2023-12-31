import type { TorrentCollection } from './torrents'
import type { SettingsCollection } from './settings'

import { getLeaderElectorByBroadcastChannel } from 'rxdb/plugins/leader-election'
import { createRxDatabase } from 'rxdb'
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie'
import { BroadcastChannel } from 'broadcast-channel'

const broadcastChannel = new BroadcastChannel('ripple')

export type Collections = {
  torrents: TorrentCollection
  settings: SettingsCollection
}

export const database = await createRxDatabase<Collections>({
  name: 'ripple',
  storage: getRxStorageDexie(),
  multiInstance: true,
  eventReduce: true
})

export type Database = typeof database

// const { broadcastChannel } = database.leaderElector()

const leaderElector = getLeaderElectorByBroadcastChannel(broadcastChannel)

export {
  leaderElector,
  broadcastChannel
}
