/**
 * Debounced persistence: while a document is being edited we save at most
 * once per `debounceMs` window (trailing edge), instead of on every keystroke.
 *
 * markDirty() is called on every Yjs update; the first call in a window arms
 * the timer, later calls within the window are coalesced. flush() is used for
 * "must persist now" moments (last client disconnected, snapshot requested,
 * server shutdown).
 */
export class DebouncedSaver {
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private saving: Promise<void> | null = null;

  constructor(
    private readonly save: () => Promise<void>,
    private readonly debounceMs: number,
  ) {}

  markDirty(): void {
    this.dirty = true;
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.debounceMs);
    }
  }

  /** Persist immediately if there are unsaved changes. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Serialize concurrent flushes so saves never interleave.
    if (this.saving) await this.saving;
    if (!this.dirty) return;
    this.dirty = false;
    this.saving = this.save().finally(() => {
      this.saving = null;
    });
    await this.saving;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
