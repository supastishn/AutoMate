// Simple event bus for data updates pushed via WebSocket
type Listener = (resource: string, data: any) => void
const listeners = new Set<Listener>()

export function onDataUpdate(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitDataUpdate(resource: string, data: any): void {
  for (const l of listeners) l(resource, data)
}
