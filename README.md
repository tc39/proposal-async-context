# Async Context for JavaScript

Status: Stage 2

Champions:

- Chengzhong Wu ([@legendecas](https://github.com/legendecas))
- Justin Ridgewell ([@jridgewell](https://github.com/jridgewell))

# Motivation

When writing synchronous JavaScript code, a reasonable expectation from
developers is that values are consistently available over the life of the
synchronous execution. These values may be passed explicitly (i.e., as
parameters to the function or some nested function, or as a closed over
variable), or implicitly (extracted from the call stack, e.g., outside the scope
as a external object that the function or nested function has access to).

```javascript
function program() {
  const value = { key: 123 };

  // Explicitly pass the value to function via parameters.
  // The value is available for the full execution of the function.
  explicit(value);

  // Explicitly captured by the closure.
  // The value is available for as long as the closure exists.
  const closure = () => {
    assert.equal(value.key, 123);
  };

  // Implicitly propagated via shared reference to an external variable.
  // The value is available as long as the shared reference is set.
  // In this case, for as long as the synchronous execution of the
  // try-finally code.
  try {
    shared = value;
    implicit();
  } finally {
    shared = undefined;
  }
}

function explicit(value) {
  assert.equal(value.key, 123);
}

let shared;
function implicit() {
  assert.equal(shared.key, 123);
}

program();
```

Async/await syntax improved in ergonomics of writing asynchronous JS. It allows
developers to think of asynchronous code in terms of synchronous code. The
behavior of the event loop executing the code remains the same as in a promise
chain. However, passing code through the event loop loses _implicit_ information
from the call site because we end up replacing the call stack. In the case of
async/await syntax, the loss of implicit call site information becomes invisible
due to the visual similarity to synchronous code -- the only indicator of a
barrier is the `await` keyword. As a result, code that "just works" in
synchronous JS has unexpected behavior in asynchronous JS while appearing almost
exactly the same.

```javascript
function program() {
  const value = { key: 123 };

  // Implicitly propagated via shared reference to an external variable.
  // The value is only available only for the _synchronous execution_ of
  // the try-finally code.
  try {
    shared = value;
    implicit();
  } finally {
    shared = undefined;
  }
}

let shared;
async function implicit() {
  // The shared reference is still set to the correct value.
  assert.equal(shared.key, 123);

  await 1;

  // After awaiting, the shared reference has been reset to `undefined`.
  // We've lost access to our original value.
  assert.throws(() => {
    assert.equal(shared.key, 123);
  });
}

program();
```

The above problem existed already in promise callback-style code, but the
introduction of async/await syntax has aggravated it by making the stack
replacement almost undetectable. This problem is not generally solvable with
user land code alone. For instance, if the call stack has already been replaced
by the time the function is called, that function will never have a chance to
capture the shared reference.

```javascript
function program() {
  const value = { key: 123 };

  // Implicitly propagated via shared reference to an external variable.
  // The value is only available only for the _synchronous execution_ of
  // the try-finally code.
  try {
    shared = value;
    setTimeout(implicit, 0);
  } finally {
    shared = undefined;
  }
}

let shared;
function implicit() {
  // By the time this code is executed, the shared reference has already
  // been reset. There is no way for `implicit` to solve this because
  // because the bug is caused (accidentally) by the `program` function.
  assert.throws(() => {
    assert.equal(shared.key, 123);
  });
}

program();
```

Furthermore, the async/await syntax bypasses the userland Promises and
makes it impossible for existing tools like [Zone.js](#zonesjs) that
[instruments](https://github.com/angular/angular/blob/main/packages/zone.js/STANDARD-APIS.md)
the `Promise` to work with it without transpilation.

This proposal introduces a general mechanism by which lost implicit call site
information can be captured and used across transitions through the event loop,
while allowing the developer to write async code largely as they do in cases
without implicit information. The goal is to reduce the mental burden currently
required for special handling async code in such cases.

## Summary

This proposal introduces APIs to propagate a value through asynchronous code,
such as a promise continuation or async callbacks.

Compared to the [Prior Arts](#prior-arts), this proposal identifies the
following features as non-goals:

1. Async tasks scheduling and interception.
1. Error handling & bubbling through async stacks.

# Proposed Solution

`AsyncContext` is designed as a value store for context propagation across
logically-connected sync/async code execution.

```typescript
namespace AsyncContext {
  class Variable<T> {
    constructor(options: AsyncVariableOptions<T>);
    get name(): string;
    run<R>(value: T, fn: (...args: any[])=> R, ...args: any[]): R;
    get(): T | undefined;
  }
  interface AsyncVariableOptions<T> {
    name?: string;
    defaultValue?: T;
  }

  class Snapshot {
    constructor();
    run<R>(fn: (...args: any[]) => R, ...args: any[]): R;
    wrap<T, R>(fn: (this: T, ...args: any[]) => R): (this: T, ...args: any[]) => R;
  }
}
```

## `AsyncContext.Variable`

`Variable` is a container for a value that is associated with the current
execution flow. The value is propagated through async execution flows, and
can be snapshot and restored with `Snapshot`.

`Variable.prototype.run()` and `Variable.prototype.get()` sets and gets
the current value of an async execution flow.

```typescript
const asyncVar = new AsyncContext.Variable();

// Sets the current value to 'top', and executes the `main` function.
asyncVar.run("top", main);

function main() {
  // AsyncContext.Variable is maintained through other platform queueing.
  setTimeout(() => {
    console.log(asyncVar.get()); // => 'top'

    asyncVar.run("A", () => {
      console.log(asyncVar.get()); // => 'A'

      setTimeout(() => {
        console.log(asyncVar.get()); // => 'A'
      }, randomTimeout());
    });
  }, randomTimeout());

  // AsyncContext.Variable runs can be nested.
  asyncVar.run("B", () => {
    console.log(asyncVar.get()); // => 'B'

    setTimeout(() => {
      console.log(asyncVar.get()); // => 'B'
    }, randomTimeout());
  });

  // AsyncContext.Variable was restored after the previous run.
  console.log(asyncVar.get()); // => 'top'
}

function randomTimeout() {
  return Math.random() * 1000;
}
```

> Note: There are controversial thought on the dynamic scoping and
> `Variable`, checkout [SCOPING.md][] for more details.

Hosts are expected to use the infrastructure in this proposal to allow tracking
not only asynchronous callstacks, but other ways to schedule jobs on the event
loop (such as `setTimeout`) to maximize the value of these use cases.

A detailed example of use cases can be found in the
[Use cases document](./USE-CASES.md).

## `AsyncContext.Snapshot`

`Snapshot` allows you to opaquely capture the current values of all `Variable`s
and execute a function at a later time as if those values were still the
current values (a snapshot and restore).

Note that even with `Snapshot`, you can only access the value associated with
a `Variable` instance if you have access to that instance.

```typescript
const asyncVar = new AsyncContext.Variable();

let snapshot
asyncVar.run("A", () => {
  // Captures the state of all AsyncContext.Variable's at this moment.
  snapshot = new AsyncContext.Snapshot();
});

asyncVar.run("B", () => {
  console.log(asyncVar.get()); // => 'B'

  // The snapshot will restore all AsyncContext.Variable to their snapshot
  // state and invoke the wrapped function. We pass a function which it will
  // invoke.
  snapshot.run(() => {
    // Despite being lexically nested inside 'B', the snapshot restored us to
    // to the snapshot 'A' state.
    console.log(asyncVar.get()); // => 'A'
  });
});
```

`Snapshot` is useful for implementing APIs that logically "schedule" a
callback, so the callback will be called with the context that it logically
belongs to, regardless of the context under which it actually runs:

```typescript
let queue = [];

export function enqueueCallback(cb: () => void) {
  // Each callback is stored with the context at which it was enqueued.
  const snapshot = new AsyncContext.Snapshot();
  queue.push(() => snapshot.run(cb));
}

runWhenIdle(() => {
  // All callbacks in the queue would be run with the current context if they
  // hadn't been wrapped.
  for (const cb of queue) {
    cb();
  }
  queue = [];
});
```

A detailed explanation of why `AsyncContext.Snapshot` is a requirement can be
found in [SNAPSHOT.md](./SNAPSHOT.md).

### `AsyncContext.Snapshot.wrap`

`AsyncContext.Snapshot.wrap` is a helper which captures the current values of all
`Variable`s and returns a wrapped function. When invoked, this wrapped function
restores the state of all `Variable`s and executes the inner function.

You can think of this as a more convenient version of `Snapshot`, where only a
single function needs to be wrapped. It also serves as a convenient way for
consumers of libraries that don't support `AsyncContext` to ensure that function
is executed in the correct execution context.

```typescript
const asyncVar = new AsyncContext.Variable();

function fn() {
  return asyncVar.get();
}

let wrappedFn;
asyncVar.run("A", () => {
  // Captures the state of all AsyncContext.Variable's at this moment, returning
  // wrapped closure that restores that state.
  wrappedFn = AsyncContext.Snapshot.wrap(fn)
});


console.log(fn()); // => undefined
console.log(wrappedFn()); // => 'A'
```

# Examples

## Determine the initiator of a task

Application monitoring tools like OpenTelemetry save their tracing spans in the
`AsyncContext.Variable` and retrieve the span when they need to determine what started
this chain of interaction.

These libraries can not intrude the developer APIs for seamless monitoring. The
tracing span doesn't need to be manually passing around by usercodes.

```typescript
// tracer.js

const asyncVar = new AsyncContext.Variable();
export function run(cb) {
  // (a)
  const span = {
    startTime: Date.now(),
    traceId: randomUUID(),
    spanId: randomUUID(),
  };
  asyncVar.run(span, cb);
}

export function end() {
  // (b)
  const span = asyncVar.get();
  span?.endTime = Date.now();
}
```

```typescript
// my-app.js
import * as tracer from "./tracer.js";

button.onclick = (e) => {
  // (1)
  tracer.run(() => {
    fetch("https://example.com").then((res) => {
      // (2)

      return processBody(res.body).then((data) => {
        // (3)

        const dialog = html`<dialog>
          Here's some cool data: ${data} <button>OK, cool</button>
        </dialog>`;
        dialog.show();

        tracer.end();
      });
    });
  });
};
```

In the example above, `run` and `end` don't share same lexical scope with actual
code functions, and they are capable of async reentrance thus capable of
concurrent multi-tracking.

## Transitive task attribution

User tasks can be scheduled with attributions. With `AsyncContext.Variable`, task
attributions are propagated in the async task flow and sub-tasks can be
scheduled with the same priority.

```typescript
const scheduler = {
  asyncVar: new AsyncContext.Variable(),
  postTask(task, options) {
    // In practice, the task execution may be deferred.
    // Here we simply run the task immediately.
    return this.asyncVar.run({ priority: options.priority }, task);
  },
  currentTask() {
    return this.asyncVar.get() ?? { priority: "default" };
  },
};

const res = await scheduler.postTask(task, { priority: "background" });
console.log(res);

async function task() {
  // Fetch remains background priority by referring to scheduler.currentPriority().
  const resp = await fetch("/hello");
  const text = await resp.text();

  scheduler.currentTask(); // => { priority: 'background' }
  return doStuffs(text);
}

async function doStuffs(text) {
  // Some async calculation...
  return text;
}
```

## User-land queues

User-land queues can be implemented with `AsyncContext.Snapshot` to propagate
the values of all `AsyncContext.Variable`s without access to any of them. This
allows the user-land queue to be implemented in a way that is decoupled from
consumers of `AsyncContext.Variable`.

```typescript
// The scheduler doesn't access to any AsyncContext.Variable.
const scheduler = {
  queue: [],
  postTask(task) {
    // Each callback is stored with the context at which it was enqueued.
    const snapshot = new AsyncContext.Snapshot();
    queue.push(() => snapshot.run(task));
  },
  runWhenIdle() {
    // All callbacks in the queue would be run with the current context if they
    // hadn't been wrapped.
    for (const cb of this.queue) {
      cb();
    }
    this.queue = [];
  }
};

function userAction() {
  scheduler.postTask(function userTask() {
    console.log(traceContext.get());
  });
}

// Tracing libraries can use AsyncContext.Variable to store tracing contexts.
const traceContext = new AsyncContext.Variable();
traceContext.run("trace-id-a", userAction);
traceContext.run("trace-id-b", userAction);

scheduler.runWhenIdle();
// The userTask will be run with the trace context it was enqueued with.
// => 'trace-id-a'
// => 'trace-id-b'
```

# FAQ

## Why take a function in `run`?

The `Variable.prototype.run` and `Snapshot.prototype.run` methods take a
function to execute because it ensures async context variables
will always contain consistent values in a given execution flow. Any modification
must be taken in a sub-graph of an async execution flow, and can not affect
their parent or sibling scopes.

```typescript
const asyncVar = new AsyncContext.Variable();
asyncVar.run("A", async () => {
  asyncVar.get(); // => 'A'

  // ...arbitrary synchronous codes.
  // ...or await-ed asynchronous calls.

  // The value can not be modified at this point.
  asyncVar.get(); // => 'A'
});
```

This increases the integrity of async context variables, and makes them
easier to reason about where a value of an async variable comes from.

# Prior Arts

## zones.js

Zones proposed a `Zone` object, which has the following API:

```typescript
class Zone {
  constructor({ name, parent });

  name;
  get parent();

  fork({ name });
  run(callback);
  wrap(callback);

  static get current();
}
```

The concept of the _current zone_, reified as `Zone.current`, is crucial. Both
`run` and `wrap` are designed to manage running the current zone:

- `z.run(callback)` will set the current zone to `z` for the duration of
  `callback`, resetting it to its previous value afterward. This is how you
  "enter" a zone.
- `z.wrap(callback)` produces a new function that essentially performs
  `z.run(callback)` (passing along arguments and this, of course).

The _current zone_ is the async context that propagates with all our operations.
In our above example, sites `(1)` through `(6)` would all have the same value of
`Zone.current`. If a developer had done something like:

```typescript
const loadZone = Zone.current.fork({ name: "loading zone" });
window.onload = loadZone.wrap(e => { ... });
```

then at all those sites, `Zone.current` would be equal to `loadZone`.

## Node.js `domain` module

Domain's global central active domain can be consumed by multiple endpoints and
be exchanged in any time with synchronous operation (`domain.enter()`). Since it
is possible that some third party module changed active domain on the fly and
application owner may unaware of such change, this can introduce unexpected
implicit behavior and made domain diagnosis hard.

Check out [Domain Module Postmortem][] for more details.

## Node.js `async_hooks`

This is what the proposal evolved from. `async_hooks` in Node.js enabled async
resources tracking for APM vendors. On which Node.js also implemented
`AsyncLocalStorage`.

## Chrome Async Stack Tagging API

Frameworks can schedule tasks with their own userland queues. In such case, the
stack trace originated from the framework scheduling logic tells only part of
the story.

```console
Error: Call stack
  at someTask (example.js)
  at loop (framework.js)
```

The Chrome [Async Stack Tagging API][] introduces a new console method named
`console.createTask()`. The API signature is as follows:

```typescript
interface Console {
  createTask(name: string): Task;
}

interface Task {
  run<T>(f: () => T): T;
}
```

`console.createTask()` snapshots the call stack into a `Task` record. And each
`Task.run()` restores the saved call stack and append it to newly generated call
stacks.

```console
Error: Call stack
  at someTask (example.js)
  at loop (framework.js)          // <- Task.run
  at async someTask               // <- Async stack appended
  at schedule (framework.js)      // <- console.createTask
  at businessLogic (example.js)
```

[async stack traces]: https://v8.dev/docs/stack-trace-api#async-stack-traces
[`asyncresource.runinasyncscope`]:
  https://nodejs.org/dist/latest-v14.x/docs/api/async_hooks.html#async_hooks_asyncresource_runinasyncscope_fn_thisarg_args
[domain module postmortem]: https://nodejs.org/en/docs/guides/domain-postmortem/
[solution.md]: ./SOLUTION.md
[scoping.md]: ./SCOPING.md
[async stack tagging api]:
  https://developer.chrome.com/blog/devtools-modern-web-debugging/#linked-stack-traces
