// These tests were directly adapted from ../async-context.test.ts, with
// different imports and no Promise.prototype.then wrapping. These tests are
// "polyfillable" in the sense that they could pass using a polyfill
// implementation like the one from PR #14, but no polyfill is needed when the
// tests are executed using benjamn/deno:async-context.

import * as assert from "https://deno.land/std@0.173.0/node/assert.ts";
import { describe, it } from "https://deno.land/std@0.173.0/testing/bdd.ts";

type Value = { id: number };
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("sync", () => {
  describe("run and get", () => {
    it("has initial undefined state", () => {
      const ctx = new AsyncContext<Value>();

      const actual = ctx.get();

      assert.equal(actual, undefined);
    });

    it("return value", () => {
      const ctx = new AsyncContext<Value>();
      const expected = { id: 1 };

      const actual = ctx.run({ id: 2 }, () => expected);

      assert.equal(actual, expected);
    });

    it("get returns current context value", () => {
      const ctx = new AsyncContext<Value>();
      const expected = { id: 1 };

      const actual = ctx.run(expected, () => ctx.get());

      assert.equal(actual, expected);
    });

    it("get within nesting contexts", () => {
      const ctx = new AsyncContext<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const actual = ctx.run(first, () => {
        return [ctx.get(), ctx.run(second, () => ctx.get()), ctx.get()];
      });

      assert.deepStrictEqual(actual, [first, second, first]);
    });

    it("get within nesting different contexts", () => {
      const a = new AsyncContext<Value>();
      const b = new AsyncContext<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const actual = a.run(first, () => {
        return [
          a.get(),
          b.get(),
          ...b.run(second, () => [a.get(), b.get()]),
          a.get(),
          b.get(),
        ];
      });

      assert.deepStrictEqual(actual, [
        first,
        undefined,
        first,
        second,
        first,
        undefined,
      ]);
    });
  });

  describe("wrap", () => {
    it("stores initial undefined state", () => {
      const ctx = new AsyncContext<Value>();
      const wrapped = AsyncContext.wrap(() => ctx.get());

      const actual = ctx.run({ id: 1 }, () => wrapped());

      assert.equal(actual, undefined);
    });

    it("stores current state", () => {
      const ctx = new AsyncContext<Value>();
      const expected = { id: 1 };

      const wrapped = ctx.run(expected, () => {
        return AsyncContext.wrap(() => ctx.get());
      });

      const actual = wrapped();

      assert.equal(actual, expected);
    });

    it("wrap within nesting contexts", () => {
      const ctx = new AsyncContext<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const actual = ctx.run(first, () => {
        const wrapped = ctx.run(second, () => {
          return AsyncContext.wrap(() => ctx.get());
        });
        return [ctx.get(), wrapped(), ctx.get()];
      });

      assert.deepStrictEqual(actual, [first, second, first]);
    });

    it("wrap out of order", () => {
      const ctx = new AsyncContext<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const firstWrap = ctx.run(first, () => {
        return AsyncContext.wrap(() => ctx.get());
      });
      const secondWrap = ctx.run(second, () => {
        return AsyncContext.wrap(() => ctx.get());
      });
      const actual = [firstWrap(), secondWrap(), firstWrap(), secondWrap()];

      assert.deepStrictEqual(actual, [first, second, first, second]);
    });
  });
});

describe("async via promises", () => {
  // beforeEach(() => {
  //   Promise.prototype.then = then;
  // });
  // afterEach(() => {
  //   Promise.prototype.then = nativeThen;
  // });

  describe("run and get", () => {
    it("get returns current context value", async () => {
      const ctx = new AsyncContext<Value>();
      const expected = { id: 1 };

      const actual = await ctx.run(expected, () => {
        return Promise.resolve().then(() => ctx.get());
      });

      assert.equal(actual, expected);
    });

    it("get within nesting contexts", async () => {
      const ctx = new AsyncContext<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const actual = await ctx.run(first, () => {
        return Promise.resolve<Value[]>([])
          .then((temp) => {
            temp.push(ctx.get());
            return temp;
          })
          .then((temp) => {
            return ctx.run(second, () => {
              return Promise.resolve().then(() => {
                temp.push(ctx.get());
                return temp;
              });
            });
          })
          .then((temp) => {
            temp.push(ctx.get());
            return temp;
          });
      });

      assert.deepStrictEqual(actual, [first, second, first]);
    });

    it("get within nesting different contexts", async () => {
      const a = new AsyncContext<Value>();
      const b = new AsyncContext<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const actual = await a.run(first, () => {
        return Promise.resolve<Value[]>([])
          .then((temp) => {
            temp.push(a.get(), b.get());
            return temp;
          })
          .then((temp) => {
            return b.run(second, () => {
              return Promise.resolve().then(() => {
                temp.push(a.get(), b.get());
                return temp;
              });
            });
          })
          .then((temp) => {
            temp.push(a.get(), b.get());
            return temp;
          });
      });

      assert.deepStrictEqual(actual, [
        first,
        undefined,
        first,
        second,
        first,
        undefined,
      ]);
    });

    it("get out of order", async () => {
      const ctx = new AsyncContext<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const firstRun = ctx.run(first, () => {
        return [
          sleep(10).then(() => ctx.get()),
          sleep(20).then(() => ctx.get()),
          sleep(30).then(() => ctx.get()),
        ];
      });
      const secondRun = ctx.run(second, () => {
        return [
          sleep(25).then(() => ctx.get()),
          sleep(15).then(() => ctx.get()),
          sleep(5).then(() => ctx.get()),
        ];
      });

      const actual = await Promise.all(firstRun.concat(secondRun));

      assert.deepStrictEqual(actual, [
        first,
        first,
        first,
        second,
        second,
        second,
      ]);
    });
  });
});
