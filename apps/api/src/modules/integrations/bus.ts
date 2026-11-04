/**
 * In-process notice that a connection changed (tokens, status, capabilities),
 * so in-memory caches (Home "Upcoming") drop what they hold for it.
 */
type Listener = (connectionId: string) => void;
const listeners = new Set<Listener>();

export function onConnectionChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function connectionChanged(connectionId: string): void {
  for (const l of listeners) l(connectionId);
}
