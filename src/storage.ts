import { AsyncContext } from "./index";
import { FrozenMap } from "./map";
import type { Data } from "./map";

let __data__: Data<unknown> | null = new Map();

// Frozen uses undefined to signal not present,
// and null to signal "frozen" empty state.
let __frozen__: FrozenMap<unknown> | null | undefined = undefined;

export class Storage {
  snapshot(freeze: boolean) {
    if (freeze) freezeData();
    return new Snapshot(freeze);
  }

  get<T>(key: AsyncContext<T>): T | undefined {
    const map = current<T>();
    return map?.get(key);
  }

  set<T>(key: AsyncContext<T>, value: T): Undo {
    const undo = new Undo(key);
    set(key, value);
    return undo;
  }
}

/**
 * A helper to get the current map
 */
function current<T>(): Data<T> | FrozenMap<T> | null {
  // We prioritize mutable data so mutations do not need to clone.
  if (__data__) return __data__ as Data<T>;
  assert(
    __frozen__ !== undefined,
    "data can only be empty if we just froze it"
  );
  return __frozen__ as FrozenMap<T> | null;
}

function set<T>(key: AsyncContext<T>, value: T): void {
  // If current is null, we're in the initial empty state.
  const map = current<T>() || new Map();
  __data__ = map.set(key, value);
  __frozen__ = undefined;
}

function del<T>(key: AsyncContext<T>): void {
  if (__data__) {
    __data__.delete(key);
  } else {
    // del is only called from Undo.edit() (which is only called during run),
    // guaranteeing there is data _somewhere_. If data didn't exist, then
    // we must have frozen it.
    assert(__frozen__ != null, "del is only called from undo");
    __data__ = __frozen__.delete(key);
  }
  __frozen__ = undefined;
}

function freezeData(): void {
  if (__frozen__ === undefined) {
    // There's no reason to freeze an empty map.
    if (__data__ && __data__.size > 0) {
      __frozen__ = new FrozenMap(__data__);
      // Now that the frozen map owns the data, we cannot mutate it further.
      __data__ = null;
    } else {
      __frozen__ = null;
    }
  }
}

/**
 * Snapshot stores the full state, allowing us to revert back to it at any
 * time.
 *
 * Two snapshots are taken during wrap, one during the wrappers creation and
 * one while invoking the wrapper. The first is guaranteed to have run
 * directly after freezing, so __data__ will be null. The second allows us to
 * capture the state immediately before we restore the first.
 */
class Snapshot {
  #prevData: Data<unknown> | null;
  #prevFrozen = __frozen__;

  constructor(freeze: boolean) {
    this.#prevData = freeze ? null : __data__;
  }

  restore() {
    __data__ = this.#prevData;
    __frozen__ = this.#prevFrozen;
  }
}

/**
 * Undo allows us to, well, undo the run operation's set.
 */
class Undo {
  #prevFrozen = __frozen__;
  #key: AsyncContext<unknown>;
  #has: boolean;
  #value: unknown;

  constructor(key: AsyncContext<unknown>) {
    const map = current();
    this.#key = key;
    this.#has = map?.has(key) || false;
    this.#value = map?.get(key);
  }

  /**
   * This is only called during run, and we're guaranteed to have some state
   * when undoing.
   */
  edit() {
    const nexFrozen = this.#prevFrozen;
    const curFrozen = __frozen__;

    // If current is frozen we should avoid cloning, but we can only do it
    // if the next state (the original state before run) is also frozen.
    if (curFrozen !== undefined && nexFrozen !== undefined) {
      // This defers the clone until the next modification is needed (either a
      // run or an exit).
      __data__ = null;
      __frozen__ = nexFrozen;
      return;
    }

    if (this.#has) {
      set(this.#key, this.#value);
    } else {
      del(this.#key);
    }
    __frozen__ = nexFrozen;
  }
}

function assert(value: unknown, message: string): asserts value {
  if (!value) {
    debugger;
    throw new Error(message);
  }
}
