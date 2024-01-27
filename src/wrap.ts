import { Storage } from "./storage";

import type { AnyFunc } from "./types";

export function wrap<F extends AnyFunc<any>>(fn: F): F {
  const snapshot = Storage.snapshot();

  function wrap(this: ThisType<F>, ...args: Parameters<F>): ReturnType<F> {
    const revert = Storage.switch(snapshot);
    try {
      return fn.apply(this, args);
    } finally {
      Storage.restore(revert);
    }
  }

  return wrap as unknown as F;
}
