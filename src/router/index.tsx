import { RouterProvider } from 'react-router'
import { createBrowserRouter } from 'react-router-dom'

import Embed             from './embed'
import Home              from './home'
import Watch             from './watch'
import FileHandler       from './file-handler'
import ProtocolHandler   from './protocol-handler'
import { getRouterRoutePath, Route } from './path'

const router = createBrowserRouter([
  { path: getRouterRoutePath(Route.HOME),             element: <Home/> },
  { path: getRouterRoutePath(Route.WATCH),            element: <Watch/> },
  { path: getRouterRoutePath(Route.EMBED),            element: <Embed/> },
  { path: getRouterRoutePath(Route.FILE_HANDLER),     element: <FileHandler/> },
  { path: getRouterRoutePath(Route.PROTOCOL_HANDLER), element: <ProtocolHandler/> }
])

export const RouterMount = () => <RouterProvider router={router}/>
export default RouterMount
