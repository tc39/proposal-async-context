import { AsyncContext } from "../src/index";
import { strict as assert } from "assert";

type Value = { id: number };

const _it = it;
it = (() => {
  throw new Error("use `test` function");
}) as any;

// Test both from the initial state, and from a run state.
// This is because the initial state might be "frozen", and
// that can cause different code paths.
function test(name: string, fn: () => void) {
  _it(name, () => {
    fn();

    // Ensure we're running from a new state, which won't be frozen.
    const throwaway = new AsyncContext.Variable<null>();
    throwaway.run(null, fn);

    throwaway.run(null, () => {
      AsyncContext.Snapshot.wrap(() => {});

      // Ensure we're running from a new state, which is frozen.
      fn();
    });
  });
}

describe("sync", () => {
  describe("run and get", () => {
    test("has initial undefined state", () => {
      const ctx = new AsyncContext.Variable<Value>();

      const actual = ctx.get();

      assert.equal(actual, undefined);
    });

    test("return value", () => {
      const ctx = new AsyncContext.Variable<Value>();
      const expected = { id: 1 };

      const actual = ctx.run({ id: 2 }, () => expected);

      assert.equal(actual, expected);
    });

    test("get returns current context value", () => {
      const ctx = new AsyncContext.Variable<Value>();
      const expected = { id: 1 };

      ctx.run(expected, () => {
        assert.equal(ctx.get(), expected);
      });
    });

    test("get within nesting contexts", () => {
      const ctx = new AsyncContext.Variable<Value>();
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

    test("get within nesting different contexts", () => {
      const a = new AsyncContext.Variable<Value>();
      const b = new AsyncContext.Variable<Value>();
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
    test("stores initial undefined state", () => {
      const ctx = new AsyncContext.Variable<Value>();
      const wrapped = AsyncContext.Snapshot.wrap(() => ctx.get());

      ctx.run({ id: 1 }, () => {
        assert.equal(wrapped(), undefined);
      });
    });

    test("stores current state", () => {
      const ctx = new AsyncContext.Variable<Value>();
      const expected = { id: 1 };

      const wrap = ctx.run(expected, () => {
        const wrap = AsyncContext.Snapshot.wrap(() => ctx.get());
        assert.equal(wrap(), expected);
        assert.equal(ctx.get(), expected);
        return wrap;
      });

      assert.equal(wrap(), expected);
      assert.equal(ctx.get(), undefined);
    });

    test("runs within wrap", () => {
      const ctx = new AsyncContext.Variable<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const [wrap1, wrap2] = ctx.run(first, () => {
        const wrap1 = AsyncContext.Snapshot.wrap(() => {
          assert.equal(ctx.get(), first);

          ctx.run(second, () => {
            assert.equal(ctx.get(), second);
          });

          assert.equal(ctx.get(), first);
        });
        assert.equal(ctx.get(), first);

        ctx.run(second, () => {
          assert.equal(ctx.get(), second);
        });

        const wrap2 = AsyncContext.Snapshot.wrap(() => {
          assert.equal(ctx.get(), first);

          ctx.run(second, () => {
            assert.equal(ctx.get(), second);
          });

          assert.equal(ctx.get(), first);
        });
        assert.equal(ctx.get(), first);
        return [wrap1, wrap2];
      });

      wrap1();
      wrap2();
      assert.equal(ctx.get(), undefined);
    });

    test("runs within wrap", () => {
      const ctx = new AsyncContext.Variable<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const [wrap1, wrap2] = ctx.run(first, () => {
        const wrap1 = AsyncContext.Snapshot.wrap(() => {
          assert.equal(ctx.get(), first);

          ctx.run(second, () => {
            assert.equal(ctx.get(), second);
          });

          assert.equal(ctx.get(), first);
        });
        assert.equal(ctx.get(), first);

        ctx.run(second, () => {
          assert.equal(ctx.get(), second);
        });

        const wrap2 = AsyncContext.Snapshot.wrap(() => {
          assert.equal(ctx.get(), first);

          ctx.run(second, () => {
            assert.equal(ctx.get(), second);
          });

          assert.equal(ctx.get(), first);
        });
        assert.equal(ctx.get(), first);
        return [wrap1, wrap2];
      });

      wrap1();
      wrap2();
      assert.equal(ctx.get(), undefined);
    });

    test("runs different context within wrap", () => {
      const a = new AsyncContext.Variable<Value>();
      const b = new AsyncContext.Variable<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const [wrap1, wrap2] = a.run(first, () => {
        const wrap1 = AsyncContext.Snapshot.wrap(() => {
          assert.equal(a.get(), first);
          assert.equal(b.get(), undefined);

          b.run(second, () => {
            assert.equal(a.get(), first);
            assert.equal(b.get(), second);
          });

          assert.equal(a.get(), first);
          assert.equal(b.get(), undefined);
        });

        a.run(second, () => {});

        const wrap2 = AsyncContext.Snapshot.wrap(() => {
          assert.equal(a.get(), first);
          assert.equal(b.get(), undefined);

          b.run(second, () => {
            assert.equal(a.get(), first);
            assert.equal(b.get(), second);
          });

          assert.equal(a.get(), first);
          assert.equal(b.get(), undefined);
        });

        assert.equal(a.get(), first);
        assert.equal(b.get(), undefined);
        return [wrap1, wrap2];
      });

      wrap1();
      wrap2();
      assert.equal(a.get(), undefined);
      assert.equal(b.get(), undefined);
    });

    test("runs different context within wrap, 2", () => {
      const a = new AsyncContext.Variable<Value>();
      const b = new AsyncContext.Variable<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const [wrap1, wrap2] = a.run(first, () => {
        const wrap1 = AsyncContext.Snapshot.wrap(() => {
          assert.equal(a.get(), first);
          assert.equal(b.get(), undefined);

          b.run(second, () => {
            assert.equal(a.get(), first);
            assert.equal(b.get(), second);
          });

          assert.equal(a.get(), first);
          assert.equal(b.get(), undefined);
        });

        b.run(second, () => {});

        const wrap2 = AsyncContext.Snapshot.wrap(() => {
          assert.equal(a.get(), first);
          assert.equal(b.get(), undefined);

          b.run(second, () => {
            assert.equal(a.get(), first);
            assert.equal(b.get(), second);
          });

          assert.equal(a.get(), first);
          assert.equal(b.get(), undefined);
        });

        assert.equal(a.get(), first);
        assert.equal(b.get(), undefined);
        return [wrap1, wrap2];
      });

      wrap1();
      wrap2();
      assert.equal(a.get(), undefined);
      assert.equal(b.get(), undefined);
    });

    test("wrap within nesting contexts", () => {
      const ctx = new AsyncContext.Variable<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const [firstWrap, secondWrap] = ctx.run(first, () => {
        const firstWrap = AsyncContext.Snapshot.wrap(() => {
          assert.equal(ctx.get(), first);
        });
        firstWrap();

        const secondWrap = ctx.run(second, () => {
          const secondWrap = AsyncContext.Snapshot.wrap(() => {
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

    test("wrap within nesting different contexts", () => {
      const a = new AsyncContext.Variable<Value>();
      const b = new AsyncContext.Variable<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const [firstWrap, secondWrap] = a.run(first, () => {
        const firstWrap = AsyncContext.Snapshot.wrap(() => {
          assert.equal(a.get(), first);
          assert.equal(b.get(), undefined);
        });
        firstWrap();

        const secondWrap = b.run(second, () => {
          const secondWrap = AsyncContext.Snapshot.wrap(() => {
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

    test("wrap within nesting different contexts, 2", () => {
      const a = new AsyncContext.Variable<Value>();
      const b = new AsyncContext.Variable<Value>();
      const c = new AsyncContext.Variable<Value>();
      const first = { id: 1 };
      const second = { id: 2 };
      const third = { id: 3 };

      const wrap = a.run(first, () => {
        const wrap = b.run(second, () => {
          const wrap = c.run(third, () => {
            return AsyncContext.Snapshot.wrap(() => {
              assert.equal(a.get(), first);
              assert.equal(b.get(), second);
              assert.equal(c.get(), third);
            });
          });
          assert.equal(a.get(), first);
          assert.equal(b.get(), second);
          assert.equal(c.get(), undefined);
          return wrap;
        });
        assert.equal(a.get(), first);
        assert.equal(b.get(), undefined);
        assert.equal(c.get(), undefined);

        return wrap;
      });

      assert.equal(a.get(), undefined);
      assert.equal(b.get(), undefined);
      assert.equal(c.get(), undefined);
      wrap();
      assert.equal(a.get(), undefined);
      assert.equal(b.get(), undefined);
      assert.equal(c.get(), undefined);
    });

    test("wrap within nesting different contexts, 3", () => {
      const a = new AsyncContext.Variable<Value>();
      const b = new AsyncContext.Variable<Value>();
      const c = new AsyncContext.Variable<Value>();
      const first = { id: 1 };
      const second = { id: 2 };
      const third = { id: 3 };

      const wrap = a.run(first, () => {
        const wrap = b.run(second, () => {
          AsyncContext.Snapshot.wrap(() => {});

          const wrap = c.run(third, () => {
            return AsyncContext.Snapshot.wrap(() => {
              assert.equal(a.get(), first);
              assert.equal(b.get(), second);
              assert.equal(c.get(), third);
            });
          });
          assert.equal(a.get(), first);
          assert.equal(b.get(), second);
          assert.equal(c.get(), undefined);
          return wrap;
        });
        assert.equal(a.get(), first);
        assert.equal(b.get(), undefined);
        assert.equal(c.get(), undefined);

        return wrap;
      });

      assert.equal(a.get(), undefined);
      assert.equal(b.get(), undefined);
      assert.equal(c.get(), undefined);
      wrap();
      assert.equal(a.get(), undefined);
      assert.equal(b.get(), undefined);
      assert.equal(c.get(), undefined);
    });

    test("wrap within nesting different contexts, 4", () => {
      const a = new AsyncContext.Variable<Value>();
      const b = new AsyncContext.Variable<Value>();
      const c = new AsyncContext.Variable<Value>();
      const first = { id: 1 };
      const second = { id: 2 };
      const third = { id: 3 };

      const wrap = a.run(first, () => {
        AsyncContext.Snapshot.wrap(() => {});

        const wrap = b.run(second, () => {
          const wrap = c.run(third, () => {
            return AsyncContext.Snapshot.wrap(() => {
              assert.equal(a.get(), first);
              assert.equal(b.get(), second);
              assert.equal(c.get(), third);
            });
          });
          assert.equal(a.get(), first);
          assert.equal(b.get(), second);
          assert.equal(c.get(), undefined);
          return wrap;
        });
        assert.equal(a.get(), first);
        assert.equal(b.get(), undefined);
        assert.equal(c.get(), undefined);

        return wrap;
      });

      assert.equal(a.get(), undefined);
      assert.equal(b.get(), undefined);
      assert.equal(c.get(), undefined);
      wrap();
      assert.equal(a.get(), undefined);
      assert.equal(b.get(), undefined);
      assert.equal(c.get(), undefined);
    });

    test("wrap within nesting different contexts, 5", () => {
      const a = new AsyncContext.Variable<Value>();
      const b = new AsyncContext.Variable<Value>();
      const c = new AsyncContext.Variable<Value>();
      const first = { id: 1 };
      const second = { id: 2 };
      const third = { id: 3 };

      const wrap = a.run(first, () => {
        const wrap = b.run(second, () => {
          const wrap = c.run(third, () => {
            return AsyncContext.Snapshot.wrap(() => {
              assert.equal(a.get(), first);
              assert.equal(b.get(), second);
              assert.equal(c.get(), third);
            });
          });

          AsyncContext.Snapshot.wrap(() => {});

          assert.equal(a.get(), first);
          assert.equal(b.get(), second);
          assert.equal(c.get(), undefined);
          return wrap;
        });
        assert.equal(a.get(), first);
        assert.equal(b.get(), undefined);
        assert.equal(c.get(), undefined);

        return wrap;
      });

      assert.equal(a.get(), undefined);
      assert.equal(b.get(), undefined);
      assert.equal(c.get(), undefined);
      wrap();
      assert.equal(a.get(), undefined);
      assert.equal(b.get(), undefined);
      assert.equal(c.get(), undefined);
    });

    test("wrap within nesting different contexts, 6", () => {
      const a = new AsyncContext.Variable<Value>();
      const b = new AsyncContext.Variable<Value>();
      const c = new AsyncContext.Variable<Value>();
      const first = { id: 1 };
      const second = { id: 2 };
      const third = { id: 3 };

      const wrap = a.run(first, () => {
        const wrap = b.run(second, () => {
          const wrap = c.run(third, () => {
            return AsyncContext.Snapshot.wrap(() => {
              assert.equal(a.get(), first);
              assert.equal(b.get(), second);
              assert.equal(c.get(), third);
            });
          });
          assert.equal(a.get(), first);
          assert.equal(b.get(), second);
          assert.equal(c.get(), undefined);
          return wrap;
        });

        AsyncContext.Snapshot.wrap(() => {});

        assert.equal(a.get(), first);
        assert.equal(b.get(), undefined);
        assert.equal(c.get(), undefined);

        return wrap;
      });

      assert.equal(a.get(), undefined);
      assert.equal(b.get(), undefined);
      assert.equal(c.get(), undefined);
      wrap();
      assert.equal(a.get(), undefined);
      assert.equal(b.get(), undefined);
      assert.equal(c.get(), undefined);
    });

    test("wrap out of order", () => {
      const ctx = new AsyncContext.Variable<Value>();
      const first = { id: 1 };
      const second = { id: 2 };

      const firstWrap = ctx.run(first, () => {
        return AsyncContext.Snapshot.wrap(() => {
          assert.equal(ctx.get(), first);
        });
      });
      const secondWrap = ctx.run(second, () => {
        return AsyncContext.Snapshot.wrap(() => {
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
