import { AsyncContext } from "../src/index";
import assert from "node:assert/strict";

type Value = { id: number };

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
        const firstWrap = AsyncContext.wrap(() => ctx.get());
        const secondWrap = ctx.run(second, () => {
          return AsyncContext.wrap(() => ctx.get());
        });
        return [ctx.get(), firstWrap(), secondWrap(), ctx.get()];
      });

      assert.deepStrictEqual(actual, [first, first, second, first]);
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
