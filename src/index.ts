type AnyFunc = (...args: any) => any;
type Storage = Map<AsyncContext<unknown>, unknown>;

let __storage__: Storage = new Map();

export class AsyncContext<T> {
  static wrap<F extends AnyFunc>(fn: F): F {
    const current = __storage__;

    function wrap(...args: Parameters<F>): ReturnType<F> {
      return run(fn, current, this, args);
    };

    return wrap as unknown as F;
  }

  run<F extends AnyFunc>(
    value: T,
    fn: F,
    ...args: Parameters<F>
  ): ReturnType<F> {
    const next = new Map(__storage__);
    next.set(this, value);
    return run(fn, next, null, args);
  }

  get(): T {
    return __storage__.get(this) as T;
  }
}

function run<F extends AnyFunc>(
  fn: F,
  next: Storage,
  binding: ThisType<F>,
  args: Parameters<F>
): ReturnType<F> {
  const previous = __storage__;
  try {
    __storage__ = next;
    return fn.apply(binding, args);
  } finally {
    __storage__ = previous;
  }
}
