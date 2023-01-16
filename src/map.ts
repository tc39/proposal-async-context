import type { AsyncContext } from "./index";

export type Data<T> = Map<AsyncContext<T>, T>;

export class FrozenMap<T> {
  #map: Data<T>;

  constructor(map: Data<T>) {
    this.#map = map;
  }

  has(key: AsyncContext<T>): boolean {
    return this.#map.has(key);
  }

  get(key: AsyncContext<T>): T | undefined {
    return this.#map.get(key) as T | undefined;
  }

  set(key: AsyncContext<T>, value: T): Data<T> {
    const map = new Map(this.#map);
    map.set(key, value);
    return map as Data<T>;
  }

  delete(key: AsyncContext<T>): Data<T> | null {
    let map = this.#map;
    if (map.size === 1) return null;
    map = new Map(map);
    map.delete(key);
    return map as Data<T>;
  }
}
