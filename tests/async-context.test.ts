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

      ctx.run(expected, () => {
        assert.equal(ctx.get(), expected);
      });
    });

    it("get within nesting contexts", () => {
      const ctx = new AsyncContext<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      ctx.run(first, () => {
        assert.equal(ctx.get(), first);
        ctx.run(second, () => {
          assert.equal(ctx.get(), second);
        });
        assert.equal(ctx.get(), first);
      });
      assert.equal(ctx.get(), undefined);
    });

    it("get within nesting different contexts", () => {
      const a = new AsyncContext<Value>();
      const b = new AsyncContext<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      a.run(first, () => {
        assert.equal(a.get(), first);
        assert.equal(b.get(), undefined);
        b.run(second, () => {
          assert.equal(a.get(), first);
          assert.equal(b.get(), second);
        });
        assert.equal(a.get(), first);
        assert.equal(b.get(), undefined);
      });
      assert.equal(a.get(), undefined);
      assert.equal(b.get(), undefined);
    });
  });

  describe("wrap", () => {
    it("stores initial undefined state", () => {
      const ctx = new AsyncContext<Value>();
      const wrapped = AsyncContext.wrap(() => ctx.get());

      ctx.run({ id: 1 }, () => {
        assert.equal(wrapped(), undefined);
      });
    });

    it("stores current state", () => {
      const ctx = new AsyncContext<Value>();
      const expected = { id: 1 };

      const wrap = ctx.run(expected, () => {
        const wrap = AsyncContext.wrap(() => ctx.get());
        assert.equal(wrap(), expected);
        assert.equal(ctx.get(), expected);
        return wrap;
      });

      assert.equal(wrap(), expected);
      assert.equal(ctx.get(), undefined);
    });

    it("wrap within nesting contexts", () => {
      const ctx = new AsyncContext<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const [firstWrap, secondWrap] = ctx.run(first, () => {
        const firstWrap = AsyncContext.wrap(() => {
          assert.equal(ctx.get(), first);
        });
        firstWrap();

        const secondWrap = ctx.run(second, () => {
          const secondWrap = AsyncContext.wrap(() => {
            firstWrap();
            assert.equal(ctx.get(), second);
          });
          firstWrap();
          secondWrap();
          assert.equal(ctx.get(), second);

          return secondWrap;
        });

        firstWrap();
        secondWrap();
        assert.equal(ctx.get(), first);

        return [firstWrap, secondWrap];
      });

      firstWrap();
      secondWrap();
      assert.equal(ctx.get(), undefined);
    });

    it("wrap within nesting different contexts", () => {
      const a = new AsyncContext<Value>();
      const b = new AsyncContext<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const [firstWrap, secondWrap] = a.run(first, () => {
        const firstWrap = AsyncContext.wrap(() => {
          assert.equal(a.get(), first);
          assert.equal(b.get(), undefined);
        });
        firstWrap();

        const secondWrap = b.run(second, () => {
          const secondWrap = AsyncContext.wrap(() => {
            firstWrap();
            assert.equal(a.get(), first);
            assert.equal(b.get(), second);
          });

          firstWrap();
          secondWrap();
          assert.equal(a.get(), first);
          assert.equal(b.get(), second);

          return secondWrap;
        });

        firstWrap();
        secondWrap();
        assert.equal(a.get(), first);
        assert.equal(b.get(), undefined);

        return [firstWrap, secondWrap];
      });

      firstWrap();
      secondWrap();
      assert.equal(a.get(), undefined);
      assert.equal(b.get(), undefined);
    });

    it("wrap out of order", () => {
      const ctx = new AsyncContext<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const firstWrap = ctx.run(first, () => {
        return AsyncContext.wrap(() => {
          assert.equal(ctx.get(), first);
        });
      });
      const secondWrap = ctx.run(second, () => {
        return AsyncContext.wrap(() => {
          assert.equal(ctx.get(), second);
        });
      });

      firstWrap();
      secondWrap();
      firstWrap();
      secondWrap();
    });
  });
});
