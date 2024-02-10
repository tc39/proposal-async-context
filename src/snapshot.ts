import { Storage } from "./storage";

import type { FrozenRevert } from "./fork";
import type { AnyFunc } from "./types";

export class Snapshot {
  #snapshot = Storage.snapshot();

  static wrap<F extends AnyFunc<any>>(fn: F): F {
    const snapshot = Storage.snapshot();

    function wrap(this: ThisType<F>, ...args: Parameters<F>): ReturnType<F> {
      return run(fn, this, args, snapshot);
    }

    return wrap as unknown as F;
  }

  run<F extends AnyFunc<null>>(fn: F, ...args: Parameters<F>) {
    return run(fn, null as any, args, this.#snapshot);
  }
}

function run<F extends AnyFunc<any>>(
  fn: F,
  context: ThisType<F>,
  args: any[],
  snapshot: FrozenRevert
): ReturnType<F> {
  const revert = Storage.switch(snapshot);
  try {
    return fn.apply(context, args);
  } finally {
    Storage.restore(revert);
  }
}
