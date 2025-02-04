# Mutation Scope

The enforced mutation function scope APIs with `run` (as in
`AsyncContext.Snapshot.prototype.run` and `AsyncContext.Variable.prototype.run`)
requires any `Variable` value mutations or `Snapshot` restorations to be
performed within a new function scope.

Modifications to `Variable` values are propagated to its subtasks. This `.run`
scope enforcement prevents any modifications to be visible to its caller
function scope, consequently been propagated to tasks created in sibling
function calls.

For instance, given a global scheduler state and a piece of user code:

```js
globalThis.scheduler = {
  #asyncVar: new AsyncContext.Variable(),
  postTask(task, { priority }) {
    asyncVar.run(priority, task);
  },
  yield() {
    const priority = asyncVar.get();
    return new Promise(resolve => {
      // resolve at a timing depending on the priority
      resolve();
    });
  },
};

async function f() {
  await scheduler.yield();

  await someLibrary.doAsyncWork();
  someLibrary.doSyncWork();

  // this can not be affected by either `doAsyncWork` or `doSyncWork` call.
  await scheduler.yield();
}
```

In this case, the `scheduler.yield` calls in function `f` will never be affected by
sibling library function calls.

Notably, AsyncContext by itself is designed to be scoped by instance of
`AsyncContext.Variable`s, and without sharing a reference to the instance, its
value will not be affected in library calls. This example shows a design that
modifications in `AsyncContext.Variable` are only visible to logical subtasks.

## Overview

There are two types of mutation scopes in the above example:

- "sync": mutations made in synchronous execution in `someLibrary.doSyncWork()`
  (or `someLibrary.doAsyncWork()` without `await`),
- "async": mutations made in async flow in `await someLibrary.doAsyncWork()`.

Type   | Mutation not visible to parent scope                   | Mutation visible to parent scope
---    | ---                                                    | ---
Sync   | `.run(value, fn)`, set semantic with scope enforcement | set semantic without scope enforcement
Async  | `AsyncContext.Variable`                                | `ContinuationVariable`

## Usages of run

The `run` pattern can already handles many existing usage pattern well that
involves function calls, like:

- Event handlers,
- Middleware.

For example, an event handler can be easily refactored to use `.run(value, fn)`
by wrapping:

```js
function handler(event) {
  ...
}

button.addEventListener("click", handler);
// ... replace it with ...
button.addEventListener("click", event => {
  asyncVar.run(createSpan(), handler, event);
});
```

Or, on Node.js server applications, where middlewares are common to use:

```js
const middlewares = [];
function use(fn) {
  middlewares.push(fn)
}

async function runMiddlewares(req, res) {
  function next(i) {
    if (i === middlewares.length) {
      return;
    }
    return middlewares[i](req, res, next.bind(i++));
  }

  return next(0);
}
```

A tracing library like OpenTelemetry can instrument it with a simple
middleware like:

```js
async function otelMiddleware(req, res, next) {
  const w3cTraceHeaders = extractW3CHeaders(req);
  const span = createSpan(w3cTraceHeaders);
  req.setHeader('x-trace-id', span.traceId);
  try {
    await asyncVar.run(span, next);
  } catch (e) {
    span.setError(e);
  } finally {
    span.end();
  }
}
```

### Limitation of run

The enforcement of mutation scopes can reduce the chance that the mutation is
exposed to the parent scope in unexpected way, but it also increases the bar to
use the feature or migrate existing code to adopt the feature.

For example, given a snippet of code:

```js
function *gen() {
  yield computeResult();
  yield computeResult2();
}
```

If we want to scope the `computeResult` and `computeResult2` calls with a new
AsyncContext value, it needs non-trivial refactor:

```js
const asyncVar = new AsyncContext.Context();

function *gen() {
  const span = createSpan();
  yield asyncVar.run(span, () => computeResult());
  yield asyncVar.run(span, () => computeResult2());
  // ...or
  yield* asyncVar.run(span, function *() {
    yield computeResult();
    yield computeResult2();
  });
}
```

`.run(val, fn)` creates a new function body. The new function environment
is not equivalent to the outer environment and can not trivially share code
fragments between them. Additionally, `break`/`continue`/`return` can not be
refactored naively.

It will be more intuitive to be able to insert a new line and without refactor
existing code snippet.

```diff
 const asyncVar = new AsyncContext.Variable();

 function *gen() {
+  using _ = asyncVar.withValue(createSpan(i));
   yield computeResult(i);
   yield computeResult2(i);
 }
```

## The set semantic with scope enforcement

With the name of `set`, this method actually doesn't modify existing async
context snapshots, similar to consecutive `run` operations. For example, in
the following case, `set` doesn't change the context variables in async tasks
created just prior to the mutation:

An alternative to exposing the `set` semantics directly is allowing mutation
with well-known symbol interface [`@@dispose`][] by using declaration (and
potentially enforcing the `using` declaration with [`@@enter`][]).

```js
const asyncVar = new AsyncContext.Variable({ defaultValue: "default" });

{
  using _ = asyncVar.withValue("main");
  new AsyncContext.Snapshot() // snapshot 0
  console.log(asyncVar.get()); // => "main"
}

{
  using _ = asyncVar.withValue("value-1");
  new AsyncContext.Snapshot() // snapshot 1
  Promise.resolve()
    .then(() => { // continuation 1
      console.log(asyncVar.get()); // => 'value-1'
    })
}

{
  using _ = asyncVar.withValue("value-2");
  new AsyncContext.Snapshot() // snapshot 2
  Promise.resolve()
    .then(() => { // continuation 2
      console.log(asyncVar.get()); // => 'value-2'
    })
}
```

The value mapping is equivalent to:

```
⌌-----------⌍ snapshot 0
|   'main'  |
⌎-----------⌏
      |
⌌-----------⌍ snapshot 1
| 'value-1' |  <---- the continuation 1
⌎-----------⌏
      |
⌌-----------⌍ snapshot 2
| 'value-2' |  <---- the continuation 2
⌎-----------⌏
```

Each `@@enter` operation create a new value slot preventing any mutation to
existing snapshots where the current `AsyncContext.Variable`'s value was
captured.

This trait is important with both `run` and `set` because mutations to
`AsyncContext.Variable`s must not mutate prior `AsyncContext.Snapshot`s.

> Note: this also applies to [`ContinuationVariable`][]

However, the well-known symbol `@@dispose` and `@@enter` is not bound to the
`using` declaration syntax, and they can be invoked manually. This can be a
by-design feature allowing advanced userland extension, like OpenTelemetry's
example in the next section.

This can be an extension to the proposed `run` semantics.

### Use cases

The set semantic allows instrumenting existing codes without nesting them in a
new function scope and reducing the refactoring work:

```js
async function doAnotherWork() {
  // defer work to next promise tick.
  await 0;
  using span = tracer.startAsCurrentSpan("anotherWork");
  console.log("doing another work");
  // the span is closed when it's out of scope
}

async function doWork() {
  using parent = tracer.startAsCurrentSpan("parent");
  // do some work that 'parent' tracks
  console.log("doing some work...");
  const anotherWorkPromise = doAnotherWork();
  // Create a nested span to track nested work
  {
    using child = tracer.startAsCurrentSpan("child");
    // do some work that 'child' tracks
    console.log("doing some nested work...")
    // the nested span is closed when it's out of scope
  }
  await anotherWorkPromise;
  // This parent span is also closed when it goes out of scope
}
```

> This example is adapted from the OpenTelemetry Python example.
> https://opentelemetry.io/docs/languages/python/instrumentation/#creating-spans

Each `tracer.startAsCurrentSpan` invocation retrieves the parent span from its
own `AsyncContext.Variable` instance and create span as a child, and set the
child span as the current value of the `AsyncContext.Variable` instance:

```js
class Tracer {
  #var = new AsyncContext.Variable();

  startAsCurrentSpan(name) {
    let scope;
    const span = {
      name,
      parent: this.#var.get(),
      [Symbol.enter]: () => {
        scope = this.#var.withValue(span)[Symbol.enter]();
        return span;
      },
      [Symbol.dispose]: () => {
        scope[Symbol.dispose]();
      },
    };
    return span;
  }
}
```

The set semantic that doesn't mutate existing snapshots is crucial to the
`startAsCurrentSpan` example here, as it allows deferred span created in
`doAnotherWork` to be a child span of the `"parent"` instead of `"child"`,
shown as graph below:

```
⌌----------⌍
| 'parent' |
⌎----------⌏
  |   ⌌---------⌍
  |---| 'child' |
  |   ⌎---------⌏
  |   ⌌-----------------⌍
  |---| 'doAnotherWork' |
  |   ⌎-----------------⌏
```

### Alternative: Decouple mutation with scopes

To preserve the strong scope guarantees provided by `run`, an additional
constraint can also be put to `set` to declare explicit scopes of mutation.

A dedicated `AsyncContext.contextScope` can be decoupled with `run` to open a
mutable scope with a series of `set` operations.

```js
const asyncVar = new AsyncContext.Variable({ defaultValue: "default" });

asyncVar.set("A"); // Throws ReferenceError: Not in a mutable context scope.

// Executes the `main` function in a new mutable context scope.
AsyncContext.contextScope(() => {
  asyncVar.set("main");

  console.log(asyncVar.get()); // => "main"
});
// Goes out of scope and all variables are restored in the current context.

console.log(asyncVar.get()); // => "default"
```

`AsyncContext.contextScope` is basically a shortcut of
`AsyncContext.Snapshot.run`:

```js
const asyncVar = new AsyncContext.Variable({ defaultValue: "default" });

asyncVar.set("A"); // Throws ReferenceError: Not in a mutable context scope.

// Executes the `main` function in a new mutable context scope.
AsyncContext.Snapshot.wrap(() => {
  asyncVar.set("main");

  console.log(asyncVar.get()); // => "main"
})();
// Goes out of scope and all variables are restored in the current context.

console.log(asyncVar.get()); // => "default"
```

#### Use cases

One use case of `set` is that it allows more intuitive test framework
integration, or similar frameworks that have prose style declarations.

```js
describe("asynct context", () => {
  const ctx = new AsyncContext.Variable();

  beforeEach((test) => {
    ctx.set(1);
  });

  it('run in snapshot', () => {
    // This function is run as a second paragraph of the test sequence.
    assert.strictEqual(ctx.get(),1);
  });
});

function testDriver() {
  await AsyncContext.contextScope(async () => {
    runBeforeEach();
    await runTest();
    runAfterEach();
  });
}
```

However, without proper test framework support, mutations in async `beforeEach`
are still unintuitive, e.g. https://github.com/xunit/xunit/issues/1880.

This can be addressed with a callback nesting API to continue the prose:

```js
describe("asynct context", () => {
  const ctx = new AsyncContext.Variable();

  beforeEach(async (test) => {
    await undefined;
    ctx.set(1);
    test.setSnapshot(new AsyncContext.Snapshot());
  });

  it('run in snapshot', () => {
    // This function is run in the snapshot saved in `test.setSnapshot`.
    assert.strictEqual(ctx.get(),1);
  });
});

function testDriver() {
  let snapshot = new AsyncContext.Snapshot();
  await AsyncContext.contextScope(async () => {
    await runBeforeEach({
      setSnapshot(it) {
        snapshot = it;
      }
    });
    await snapshot.run(() => runTest());
    await runAfterEach();
  });
}
```

> ❓: A real world use case that facilitate the same component that uses
> `AsyncContext.Variable` in both production and test environment.

## Summary

The set semantic can be an extension to the existing proposal with `@@enter`
and `@@dispose` well-known symbols allowing using declaration scope
enforcement.

[`@@dispose`]: https://github.com/tc39/proposal-explicit-resource-management?tab=readme-ov-file#using-declarations
[`@@enter`]: https://github.com/tc39/proposal-using-enforcement?tab=readme-ov-file#proposed-solution
[`ContinuationVariable`]: ./CONTINUATION.md
