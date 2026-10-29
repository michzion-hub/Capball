export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<(payload: never) => void>>()

  on<K extends keyof Events>(type: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(type)
    if (!set) { set = new Set(); this.handlers.set(type, set) }
    set.add(fn as (payload: never) => void)
    return () => { set!.delete(fn as (payload: never) => void) }
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.handlers.get(type)
    if (!set) return
    for (const fn of [...set]) (fn as (p: Events[K]) => void)(payload)
  }

  listenerCount(): number {
    let n = 0
    for (const s of this.handlers.values()) n += s.size
    return n
  }

  clear(): void { this.handlers.clear() }
}
