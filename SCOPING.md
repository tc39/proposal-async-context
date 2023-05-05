# Scoping of AsyncLocal

The major concerns of `AsyncLocal` advancing to Stage 1 of TC39 proposal
process is that there are potential dynamic scoping of the semantics of
`AsyncLocal`.  This document is about defining the scoping of `AsyncLocal`.

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

However, the naming scope of an `AsyncLocal` is identical to a regular variable
in JavaScript. Since JavaScript variables are lexically scoped, the naming of
`AsyncLocal` instances are lexically scoped too. It is not possible to access a
value inside an `AsyncLocal` without explicit access to the `AsyncLocal` instance
itself.

```typescript
const asyncLocal = new AsyncLocal();

asyncLocal.run(1, f);
console.log(asyncLocal.get()); // => undefined

function g() {
  console.log(asyncLocal.get()); // => 1
}

function f() {
  // Intentionally named the same "asyncLocal"
  const asyncLocal = new AsyncLocal();
  asyncLocal.run(2, g);
}
```

Hence, knowing the name of an `AsyncLocal` variable does not give you the
ability to change the value of that variable. You must have direct access to it
in order to affect it.

```typescript
const asyncLocal = new AsyncLocal();

asyncLocal.run(1, f);

console.log(asyncLocal.get()); // => undefined;

function f() {
  const asyncLocal = new AsyncLocal();
  asyncLocal.run(2, g);

  function g() {
    console.log(asyncLocal.get()); // => 2;
  }
}
```

### Dynamic Scoping: dependency on caller

One argument on the dynamic scoping is that the values in `AsyncLocal` can be
changed depending on which the caller is.

However, the definition of whether the value of an `AsyncLocal` can be changed
has the same meaning with a regular JavaScript variable: anyone with direct
access to a variable has the ability to change the variable.

```typescript
class SyncLocal {
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

const syncLocal = new SyncLocal();

syncLocal.run(1, f);

console.log(syncLocal.get()); // => undefined;

function g() {
  console.log(syncLocal.get()); // => 1
}

function f() {
  // Intentionally named the same "syncLocal"
  const syncLocal = new AsyncLocal();
  syncLocal.run(2, g);
}
```

If this userland `SyncLocal` is acceptable, than adding an `AsyncLocal`
that can operate across sync/async execution should be no different.

### Summary

There are no differences regarding naming scope of `AsyncLocal` compared to
regular JavaScript variables. Only code with direct access to `AsyncLocal`
instances can modify the value, and only for code execution nested inside a new
`asyncLocal.run()`. Further, the capability to modify a local variable which you
have direct access to is already possible in sync code execution.
