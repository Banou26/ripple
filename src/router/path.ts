
export enum Route {
  HOME = 'HOME',
  WATCH = 'WATCH',
  EMBED = 'EMBED',
  FILE_HANDLER = 'FILE_HANDLER',
  PROTOCOL_HANDLER = 'PROTOCOL_HANDLER'
}

const Routes = {
  [Route.HOME]: (_?: void) => '/',
  [Route.WATCH]: ({ infoHash, fileIndex }: { infoHash: string, fileIndex?: number }) => `/watch/${infoHash}/${fileIndex ?? 0}`,
  [Route.EMBED]: (options: { magnet: string, fileIndex?: string } | { torrentFile: string, fileIndex?: string }) => `/embed?${new URLSearchParams(options as Record<string, string>).toString()}`,
  [Route.FILE_HANDLER]: (_?: void) => '/file-handler',
  [Route.PROTOCOL_HANDLER]: (_?: void) => '/protocol-handler'
} as const

const RouterRoutes = {
  [Route.HOME]: '/',
  [Route.WATCH]: '/watch/:infoHash/:fileIndex?',
  [Route.EMBED]: '/embed',
  [Route.FILE_HANDLER]: '/file-handler',
  [Route.PROTOCOL_HANDLER]: '/protocol-handler'
} as const

export const getRouterRoutePath =
  (route: Route) =>
    RouterRoutes[route]

export const getRoutePath = <
  T extends Route
> (
  route: T,
  args?: Parameters<(typeof Routes)[T]>[0]
) =>
  Routes[route](args as any)
