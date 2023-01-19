import { Storage } from "./storage";

type AnyFunc<T> = (this: T, ...args: any) => any;

export class AsyncContext<T> {
  static wrap<F extends AnyFunc<any>>(fn: F): F {
    const snapshot = Storage.snapshot();

    function wrap(this: ThisType<F>, ...args: Parameters<F>): ReturnType<F> {
      const head = Storage.switch(snapshot);
      try {
        return fn.apply(this, args);
      } finally {
        Storage.restore(head);
      }
    }

    return wrap as unknown as F;
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
    return Storage.get(this);
  }
}
