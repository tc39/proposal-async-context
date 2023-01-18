import { Mapping } from "./mapping";
import { StagedFork, StagingFork } from "./fork";
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
   * Set assigns a new value to the AsyncContext.
   */
  static set<T>(key: AsyncContext<T>, value: T): void {
    // If the Mappings are frozen (someone has snapshot it), then modifying the
    // mappings will return a clone containing the modification.
    this.#current = this.#current.set(key, value);
  }

  /**
   * Stage is called before modifying the global storage state (either by
   * replacing the current mappings or assigning a new value to an individual
   * AsyncContext).
   *
   * The Fork instance returned will be able to restore the mappings to the
   * unmodified state.
   */
  static stage<T>(key: AsyncContext<T>): StagedFork | StagingFork<T> {
    const current = this.#current;
    if (current.isFrozen()) {
      return new StagedFork(current);
    }
    return new StagingFork(current, key);
  }

  /**
   * Commit freezes the current storage state, and returns a new fork which
   * can restore the global storage state to the state at the time of the
   * commit.
   *
   * Subsequent modification to the mappings clone the committed state.
   */
  static commit(): StagedFork {
    this.#current?.freeze();
    return new StagedFork(this.#current);
  }

  /**
   * Switch restores the global storage state to the state of the given fork.
   */
  static switch<T>(fork: StagedFork | StagingFork<T>): StagedFork {
    const previous = this.#current;
    this.#current = fork.switch(previous);
    return new StagedFork(previous);
  }
}
