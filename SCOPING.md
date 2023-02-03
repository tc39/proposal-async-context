# Scoping of AsyncContext

The major concerns of `AsyncContext` advancing to Stage 1 of TC39 proposal
process is that there are potential dynamic scoping of the semantics of
`AsyncContext`.  This document is about defining the scoping of `AsyncContext`.

### Dynamic Scoping

A classic dynamic scoping issue is: the variable `x` inside a function `g` will
be determined by the caller of `g`. If `g` is called at root scope, the name `x`
refers to the one defined in the root scope. If `g` is called inside a function
`f`, the name `x` could refer to the one defined in the scope of `f`.

```bash
$ # bash language
$ x=1
$ function g () { echo $x ; x=2 ; }
$ function f () { local x=3 ; g ; }
$ f # does this print 1, or 3?
3
$ echo $x # does this print 1, or 2?
1
```

However, the naming scope of an async context is identical to a regular variable
in JavaScript. Since JavaScript variables are lexically scoped, the naming of
async context instances are lexically scoped too. It is not possible to access a
value inside an async context without explicit access to the async context
itself.

```typescript
const context = new AsyncContext();

context.run(1, f);
console.log(context.get()); // => undefined

function g() {
  console.log(context.get()); // => 1
}

function f() {
  // Intentionally named the same "context"
  const context = new AsyncContext();
  context.run(2, g);
}
```

Hence, knowing the name of an async context variable does not give you the
ability to change that context. You must have direct access to it in order to
affect it.

```typescript
const context = new AsyncContext();

context.run(1, f);

console.log(context.get()); // => undefined;

function f() {
  const context = new AsyncContext();
  context.run(2, g);

  function g() {
    console.log(context.get(); // => 2;
  }
}
```

### Dynamic Scoping: dependency on caller

One argument on the dynamic scoping is that the values in `AsyncContext` can be
changed depending on which the caller is.

However, the definition of whether the value of an async context can be changed
has the same meaning with a regular JavaScript variable: anyone with direct
access to a variable has the ability to change the variable.

```typescript
class SyncContext {
  #current;

  get() {
    return this.#current;
  }

  run(value, cb) {
    const prev = this.#current;
    try {
      this.#current = value;
      return cb();
    } finally {
      this.#current = prev;
    }
  }
}

const context = new SyncContext();

context.run(1, f);

console.log(context.get()); // => undefined;

function g() {
  console.log(context.get()); // => 1
}

function f() {
  // Intentionally named the same "context"
  const context = new AsyncContext();
  context.run(2, g);
}
```

If this userland `SyncContext` is acceptable, than adding an `AsyncContext`
that can operate across sync/async execution should be no different.

### Summary

There are no differences regarding naming scope of async contexts compared to
regular JavaScript variables. Only code with direct access to `AsyncContex`
instances can modify the value, and only for code execution nested inside a new
`context.run()`. Further, the capability to modify a local variable which you
have direct access to is already possible in sync code execution.
