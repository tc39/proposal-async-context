import { Mapping } from "./mapping";
import { FrozenRevert, Revert } from "./fork";
import type { AsyncContext } from "./index";

/**
 * Storage is the (internal to the language) storage container of all
 * AsyncContext data.
 *
 * None of the methods here are exposed to users, they're only exposed to the AsyncContext class.
 */
export class Storage {
  static #current: Mapping = new Mapping(null);

  /**
   * Get retrieves the current value assigned to the AsyncContext.
   */
  static get<T>(key: AsyncContext<T>): T | undefined {
    return this.#current.get(key);
  }

  /**
   * Set assigns a new value to the AsyncContext, returning a revert that can
   * undo the modification at a later time.
   */
  static set<T>(key: AsyncContext<T>, value: T): FrozenRevert | Revert<T> {
    // If the Mappings are frozen (someone has snapshot it), then modifying the
    // mappings will return a clone containing the modification.
    const current = this.#current;
    const undo = current.isFrozen()
      ? new FrozenRevert(current)
      : new Revert(current, key);
    this.#current = this.#current.set(key, value);
    return undo;
  }

  /**
   * Restore will, well, restore the global storage state to state at the time
   * the revert was created.
   */
  static restore<T>(revert: FrozenRevert | Revert<T>): void {
    this.#current = revert.restore(this.#current);
  }

  /**
   * Snapshot freezes the current storage state, and returns a new revert which
   * can restore the global storage state to the state at the time of the
   * snapshot.
   */
  static snapshot(): FrozenRevert {
    this.#current.freeze();
    return new FrozenRevert(this.#current);
  }

  /**
   * Switch swaps the global storage state to the state at the time of a
   * snapshot, completely replacing the current state (and making it impossible
   * for the current state to be modified until the snapshot is reverted).
   */
  static switch(snapshot: FrozenRevert): FrozenRevert {
    const previous = this.#current;
    this.#current = snapshot.restore(previous);

    // Technically, previous may not be frozen. But we know its state cannot
    // change, because the only way to modify it is to restore it to the
    // Storage container, and the only way to do that is to have snapshot it.
    // So it's either snapshot (and frozen), or it's not and thus cannot be
    // modified.
    return new FrozenRevert(previous);
  }
}
