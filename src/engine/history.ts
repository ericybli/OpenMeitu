/**
 * Linear undo/redo history of immutable states.
 * Slider drags should call `push` on the first change and `replace` for the
 * rest of the gesture, so one drag = one undo step.
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private current: T;
  private readonly limit: number;

  /** `limit` is the maximum number of undo steps kept (0 disables undo). */
  constructor(initial: T, limit = 100) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new RangeError(`History limit must be a non-negative integer, got ${limit}`);
    }
    this.current = initial;
    this.limit = limit;
  }

  get present(): T {
    return this.current;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Add a new state; clears the redo stack; drops the oldest beyond `limit`. */
  push(state: T): void {
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    this.current = state;
    this.future = [];
  }

  /**
   * Overwrite the present state without creating an undo step. A different
   * state also clears the redo stack, which no longer follows from it.
   */
  replace(state: T): void {
    if (Object.is(state, this.current)) return;
    this.current = state;
    this.future = [];
  }

  /** Step back; returns the new present, or undefined when there is nothing to undo. */
  undo(): T | undefined {
    if (this.past.length === 0) return undefined;
    this.future.push(this.current);
    this.current = this.past.pop() as T;
    return this.current;
  }

  /** Step forward; returns the new present, or undefined when there is nothing to redo. */
  redo(): T | undefined {
    if (this.future.length === 0) return undefined;
    this.past.push(this.current);
    this.current = this.future.pop() as T;
    return this.current;
  }

  /** Forget all history and start from `state`. */
  reset(state: T): void {
    this.past = [];
    this.future = [];
    this.current = state;
  }
}
