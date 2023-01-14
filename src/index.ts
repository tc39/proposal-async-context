import { Storage } from "./storage";

type AnyFunc<T> = (this: T, ...args: any) => any;

export class AsyncContext<T> {
  static wrap<F extends AnyFunc<any>>(fn: F): F {
    const snapshot = Storage.snapshot();

    function wrap(this: ThisType<F>, ...args: Parameters<F>): ReturnType<F> {
      const fork = Storage.restore(snapshot);
      try {
        return fn.apply(this, args);
      } finally {
        Storage.join(fork);
      }
    }

    return wrap as unknown as F;
  }

  run<F extends AnyFunc<null>>(
    value: T,
    fn: F,
    ...args: Parameters<F>
  ): ReturnType<F> {
    const fork = Storage.fork(this);
    Storage.set(this, value);
    try {
      return fn.apply(null, args);
    } finally {
      Storage.join(fork);
    }
  }

  get(): T {
    return Storage.get(this);
  }
}
