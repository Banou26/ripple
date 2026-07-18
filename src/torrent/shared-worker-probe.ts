;(globalThis as unknown as { onconnect: ((event: MessageEvent) => void) | null }).onconnect = (event) => {
  const port = event.ports[0]
  if (!port) return
  port.postMessage(Boolean((self.navigator as Navigator).locks))
  port.close()
}
