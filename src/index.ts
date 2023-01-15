import { Storage } from "./storage";

type AnyFunc<T> = (this: T, ...args: any) => any;

const __storage__ = new Storage();

export class AsyncContext<T> {
  static wrap<F extends AnyFunc<any>>(fn: F): F {
    const snapshot = __storage__.snapshot(true);

    function wrap(this: ThisType<F>, ...args: Parameters<F>): ReturnType<F> {
      const prev = __storage__.snapshot(false);
      try {
        snapshot.restore();
        return fn.apply(this, args);
      } finally {
        prev.restore();
      }
    }

    return wrap as unknown as F;
  }

  run<F extends AnyFunc<null>>(
    value: T,
    fn: F,
    ...args: Parameters<F>
  ): ReturnType<F> {
    const undo = __storage__.set(this, value);
    try {
      return fn.apply(null, args);
    } finally {
      undo.edit();
    }
  }

  get(): T | undefined {
    return __storage__.get(this);
  }
}
