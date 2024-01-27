import { Storage } from "./storage";

import type { AnyFunc } from "./types";

export class Snapshot {
  #snapshot = Storage.snapshot();

  run<F extends AnyFunc<any>>(fn: F, ...args: Parameters<F>) {
    const revert = Storage.switch(this.#snapshot);
    try {
      return fn.apply(this, args);
    } finally {
      Storage.restore(revert);
    }
  }
}
