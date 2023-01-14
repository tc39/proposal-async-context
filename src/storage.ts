import { Mapping } from "./mapping";
import { FrozenFork, OwnedFork } from "./fork";
import type { AsyncContext } from "./index";

/**
 * Storage is the (internal to the language) storage container of all
 * AsyncContext data.
 *
 * None of the methods here are exposed to users, they're only exposed to the AsyncContext class.
 */
export class Storage {
  static #current: Mapping | undefined = undefined;

  /**
   * Get retrieves the current value assigned to the AsyncContext.
   */
  static get<T>(key: AsyncContext<T>): T | undefined {
    return this.#current?.get(key);
  }

  /**
   * Set assigns a new value to the AsyncContext.
   */
  static set<T>(key: AsyncContext<T>, value: T) {
    const current = this.#current || new Mapping(new Map());
    // If the Mappings are frozen (someone has snapshot it), then modifying the
    // mappings will return a clone containing the modification.
    this.#current = current.set(key, value);
  }

  /**
   * Fork is called before modifying the global storage state (either by
   * replacing the current mappings or assigning a new value to an individual
   * AsyncContext).
   *
   * The Fork instance returned will be able to restore the mappings to the
   * unmodified state.
   */
  static fork<T>(key: AsyncContext<T>): FrozenFork | OwnedFork<T> {
    const current = this.#current;
    if (current === undefined || current.isFrozen()) {
      return new FrozenFork(current);
    }
    return new OwnedFork(current, key);
  }

  /**
   * Join will restore the global storage state to state at the time of the
   * fork.
   */
  static join<T>(fork: FrozenFork | OwnedFork<T>) {
    // The only way for #current to be undefined at a join is if we're in the
    // we've snapshot the initial empty state with `wrap` and restored it. In
    // which case, we're operating on a FrozenFork, and the param doesn't
    // matter. The only other call to join is in the `run` case, and that
    // guarantees that we have a mappings.
    this.#current = fork.join(this.#current!);
  }

  /**
   * Snapshot freezes the current storage state, and returns a new fork which
   * can restore the global storage state to the state at the time of the
   * snapshot.
   */
  static snapshot(): FrozenFork {
    this.#current?.freeze();
    return new FrozenFork(this.#current);
  }

  /**
   * Restore restores the global storage state to the state at the time of the
   * snapshot.
   */
  static restore(snapshot: FrozenFork): FrozenFork {
    const previous = this.#current;
    this.#current = snapshot.join(previous);

    // Technically, previous may not be frozen. But we know its state cannot
    // change, because the only way to modify it is to restore it to the
    // Storage container, and the only way to do that is to have snapshot it.
    // So it's either snapshot (and frozen), or it's not and thus cannot be
    // modified.
    return new FrozenFork(previous);
  }
}
