
export enum Route {
  HOME = 'HOME',
  WATCH = 'WATCH'
}

const Routes = {
  [Route.HOME]: () => '/',
  [Route.WATCH]: ({ infoHash, fileIndex }: { infoHash: string, fileIndex?: number }) => `/watch/${infoHash}/${fileIndex}`
}

const RouterRoutes = {
  [Route.HOME]: '/',
  [Route.WATCH]: '/watch/:infoHash/:fileIndex?'
}

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
