import { AsyncContext } from "./index";

import type { AnyFunc } from "./types";

export const nativeThen = Promise.prototype.then;

function wrapFn<F extends AnyFunc<any>>(fn: F | null | undefined) {
  if (typeof fn !== "function") return undefined;
  return AsyncContext.wrap(fn);
}

export function then<T>(
  this: Promise<T>,
  onFul?: Parameters<typeof nativeThen>[0],
  onRej?: Parameters<typeof nativeThen>[1]
): Promise<T> {
  // The onFul and onRej are always called _after at least 1_ tick. So it's
  // possible that a new Request has been handled (and a new async context
  // created). We must wrap the callbacks to restore our creation context
  // when they are invoked.
  const ful = wrapFn(onFul);
  const rej = wrapFn(onRej);

  return nativeThen.call(this, ful, rej) as Promise<T>;
}
