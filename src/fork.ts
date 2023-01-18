import type { Mapping } from "./mapping";
import type { AsyncContext } from "./index";

/**
 * StagedFork holds a Mapping that will be simply restored when the fork is
 * switched to.
 *
 * This is used when we already know that the mapping is frozen or the mapping
 * is not going to be modified, so that switching will not attempt to mutate
 * the Mapping (and allocate a new mapping) as an StagingFork would.
 */
export class StagedFork {
  #mapping: Mapping;

  constructor(mapping: Mapping) {
    this.#mapping = mapping;
  }

  /**
   * The Storage container will call switch when it wants to restore its current
   * Mapping to the state at the start of the fork.
   *
   * For StagedFork, that's as simple as returning the saved Mapping,
   * because we know it can't have been modified.
   */
  switch(): Mapping {
    return this.#mapping;
  }
}

/**
 * StagingFork holds an unfrozen Mapping that we will attempt to modify when
 * swtiched to to attempt to restore it to its prior state.
 *
 * This is used when we know that the Mapping is unfrozen at start, because
 * it's possible that no one will snapshot this Mapping before we switching. In
 * that case, we can simply modify the Mapping (without cloning) to restore it
 * to its prior state. If someone does snapshot it, then modifying will clone
 * the current state and we restore the clone to the prior state.
 */
export class StagingFork<T> {
  #key: AsyncContext<T>;
  #has: boolean;
  #prev: T | undefined;

  constructor(mapping: Mapping, key: AsyncContext<T>) {
    this.#key = key;
    this.#has = mapping.has(key);
    this.#prev = mapping.get(key);
  }

  /**
   * The Storage container will call switch when it wants to restore its current
   * Mapping to the state at the start of the fork.
   *
   * For StagingFork, we mutate the known-unfrozen-at-start mapping (which may
   * reallocate if anyone has since taken a snapshot) in the hopes that we
   * won't need to reallocate.
   */
  switch(current: Mapping): Mapping {
    if (this.#has) {
      return current.set(this.#key, this.#prev);
    } else {
      return current.delete(this.#key);
    }
  }
}
