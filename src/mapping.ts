import type { Variable } from "./variable";

/**
 * Stores all Variable data, and tracks whether any snapshots have been
 * taken of the current data.
 */
export class Mapping {
  #data: Map<Variable<unknown>, unknown>;

  /**
   * If a snapshot of this data is taken, then further modifications cannot be
   * made directly. Instead, set/delete will clone this Mapping and modify
   * _that_ instance.
   */
  #frozen = false;

  constructor(data: Map<Variable<unknown>, unknown>) {
    this.#data = data;
  }

  has<T>(key: Variable<T>): boolean {
    return this.#data.has(key) || false;
  }

  get<T>(key: Variable<T>): T | undefined {
    return this.#data.get(key) as T | undefined;
  }

  /**
   * Like the standard Map.p.set, except that we will allocate a new Mapping
   * instance if this instance is frozen.
   */
  set<T>(key: Variable<T>, value: T): Mapping {
    const mapping = this.#fork();
    mapping.#data.set(key, value);
    return mapping;
  }

  /**
   * Like the standard Map.p.delete, except that we will allocate a new Mapping
   * instance if this instance is frozen.
   */
  delete<T>(key: Variable<T>): Mapping {
    const mapping = this.#fork();
    mapping.#data.delete(key);
    return mapping;
  }

  /**
   * Prevents further modifications to this Mapping.
   */
  freeze(): void {
    this.#frozen = true;
  }

  isFrozen(): boolean {
    return this.#frozen;
  }

  /**
   * We only need to fork if the Mapping is frozen (someone has a snapshot of
   * the current data), else we can just modify our data directly.
   */
  #fork(): Mapping {
    if (this.#frozen) {
      return new Mapping(new Map(this.#data));
    }
    return this;
  }
}
