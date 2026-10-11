/** New mutations stop for this document once a forced update or maintenance is
 * known. Recovery transports remain available; only a reload creates a new gate. */
let allowed = true;
const listeners = new Set<() => void>();

export const mutationGate = Object.freeze({
  getSnapshot: (): boolean => allowed,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  close(): void {
    if (!allowed) return;
    allowed = false;
    for (const listener of listeners) listener();
  },
});
