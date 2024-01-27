import { Storage } from "./storage";

import type { AnyFunc } from "./types";

export interface VariableOptions<T> {
  name?: string;
  defaultValue?: T;
}

export class Variable<T> {
  #name = "";
  #defaultValue: T | undefined;

  constructor(options?: VariableOptions<T>) {
    if (options) {
      if ("name" in options) {
        this.#name = String(options.name);
      }
      this.#defaultValue = options.defaultValue;
    }
  }

  get name() {
    return this.#name;
  }

  run<F extends AnyFunc<null>>(
    value: T,
    fn: F,
    ...args: Parameters<F>
  ): ReturnType<F> {
    const revert = Storage.set(this, value);
    try {
      return fn.apply(null, args);
    } finally {
      Storage.restore(revert);
    }
  }

  get(): T | undefined {
    return Storage.has(this) ? Storage.get(this) : this.#defaultValue;
  }
}
