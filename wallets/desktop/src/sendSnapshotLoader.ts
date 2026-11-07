/** Serializes native snapshot reads and drops results from an old wallet scope. */
export class SendSnapshotLoader<T> {
  private scope: string | null = null;
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private pending: { generation: number; promise: Promise<T | undefined> } | null = null;

  setScope(scope: string | null): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.generation += 1;
    this.pending = null;
  }

  load(request: () => Promise<T>, fresh = false): Promise<T | undefined> {
    if (this.scope === null) return Promise.resolve(undefined);
    const generation = this.generation;
    if (!fresh && this.pending?.generation === generation) return this.pending.promise;
    const promise = this.tail.then(async () => {
      if (generation !== this.generation) return undefined;
      try {
        const value = await request();
        return generation === this.generation ? value : undefined;
      } catch (reason) {
        // An obsolete wallet's error must not replace the new wallet's state.
        if (generation === this.generation) throw reason;
        return undefined;
      }
    });
    this.pending = { generation, promise };
    this.tail = promise.then(() => undefined, () => undefined);
    const clear = () => {
      if (this.pending?.promise === promise) this.pending = null;
    };
    void promise.then(clear, clear);
    return promise;
  }
}
