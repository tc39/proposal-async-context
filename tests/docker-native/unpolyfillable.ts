import * as assert from "https://deno.land/std@0.173.0/node/assert.ts";
import { describe, it } from "https://deno.land/std@0.173.0/testing/bdd.ts";

describe("async via native async/await", () => {
  it("works after awaited setTimeout result", async () => {
    const ctx = new AsyncContext<number>();
    const ctxRunResult = await ctx.run(1234, async () => {
      assert.strictEqual(ctx.get(), 1234);
      const setTimeoutResult = await ctx.run(
        2345,
        () => new Promise(resolve => {
          setTimeout(() => resolve(ctx.get()), 20);
        }),
      );
      assert.strictEqual(setTimeoutResult, 2345);
      assert.strictEqual(ctx.get(), 1234);
      return "final result";
    }).then(result => {
      assert.strictEqual(result, "final result");
      // The code that generated the Promise has access to the 1234 value
      // provided to ctx.run above, but consumers of the Promise do not
      // automatically inherit it.
      assert.strictEqual(ctx.get(), void 0);
      return "ctx.run result 👋";
    });
    assert.strictEqual(ctxRunResult, "ctx.run result 👋");
  });
});
