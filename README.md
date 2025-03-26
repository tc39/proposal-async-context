# Async Context for JavaScript

Status: Stage 2

Champions:

- Andreu Botella ([@andreubotella](https://github.com/andreubotella))
- Chengzhong Wu ([@legendecas](https://github.com/legendecas))
- Justin Ridgewell ([@jridgewell](https://github.com/jridgewell))

Discuss with the group and join the bi-weekly via [#tc39-async-context][]
matrix room ([Matrix Guide][]).

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

Compared to the [Prior Arts][prior-arts.md], this proposal identifies the
following features as non-goals:

1. Async tasks scheduling and interception.
1. Error handling & bubbling through async stacks.

# Proposed Solution

`AsyncContext` is designed as a value store for context propagation across
logically-connected sync/async code execution.

```typescript
namespace AsyncContext {
  run<R, A extends any[]>(scope: { [key: string|Symbol]: any }, fn: (...args: A)=> R, ...args: A): R;
  get(key: string|Symbol): any;

  class Snapshot {
    constructor();
    run<R, A extends any[]>(fn: (...args: A) => R, ...args: A): R;
    get(key: string|Symbol): any;
    static wrap<T, R, A extends any[]>(fn: (this: T, ...args: A) => R): (this: T, ...args: A) => R;
  }
}
```

## `run` creates scope

With `run` it is possible to specify values that are associated with the current
execution flow. The values are propagated through async execution flows, and
can be snapshot and restored with `Snapshot`.

Using `get` it is possible to get the current value of a specific field in the execution
flow.

You can pass in any 

```typescript
const asyncVar = Symbol('asyncVar');
const { get, run } = AsyncContext;

// Sets the current value to 'top', and executes the `main` function.
run({ [asyncVar]: "top" }, main);

function main() {
  // the scope is maintained through other platform queueing.
  setTimeout(() => {
    console.log(get(asyncVar)); // => 'top'

    run({ [asyncVar]: "A" }, () => {
      console.log(get(asyncVar)); // => 'A'

      setTimeout(() => {
        console.log(get(asyncVar)); // => 'A'
      }, randomTimeout());
    });
  }, randomTimeout());

  // runs can be nested.
  run({ [asyncVar]: "B" }, () => {
    console.log(get(asyncVar)); // => 'B'

    setTimeout(() => {
      console.log(get(asyncVar)); // => 'B'
    }, randomTimeout());
  });

  // The context was restored after the previous run.
  console.log(get(asyncVar)); // => 'top'
}

function randomTimeout() {
  return Math.random() * 1000;
}
```

> Note: There are controversial thoughts on the dynamic scoping,
> checkout [SCOPING.md][] for more details.

Hosts are expected to use the infrastructure in this proposal to allow tracking
not only asynchronous callstacks, but other ways to schedule jobs on the event
loop (such as `setTimeout`) to maximize the value of these use cases. We
describe the needed integration with web platform APIs in the [web integration
document](./WEB-INTEGRATION.md).

A detailed example of use cases can be found in the
[Use cases document](./USE-CASES.md).

## `AsyncContext.Snapshot`

`Snapshot` allows you to opaquely capture the current values of all `Variable`s
and execute a function at a later time as if those values were still the
current values (a snapshot and restore).

Note that even with `Snapshot`, as long as you use keys it remains only possible to access values associated with the
variable using you can only access the value associated with
a `Variable` instance if you have access to that instance.

```typescript
const asyncVar = Symbol('asyncVar');
const { get, run, SnapShot } = AsyncContext;

let snapshot
run({ [asyncVar]: "A" }, () => {
  // Captures the state of the entire context scope at this moment.
  snapshot = new Snapshot();
});

run({ [asyncVar]: "B" }, () => {
  console.log(get(asyncVar)); // => 'B'

  // The snapshot will restore all AsyncContext.Variable to their snapshot
  // state and invoke the wrapped function. We pass a function which it will
  // invoke.
  snapshot.run(() => {
    // Despite being lexically nested inside 'B', the snapshot restored us to
    // to the snapshot 'A' state.
    console.log(get(asyncVar)); // => 'A'
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

`AsyncContext.Snapshot.wrap` is a helper which captures the current scope values
and returns a wrapped function. When invoked, this wrapped function restores
the entire state and executes the inner function.

```typescript
const asyncVar = Symbol('asyncVar');
const { get, run } = AsyncContext;

function fn() {
  return get(asyncVar);
}

let wrappedFn;
run({ [asyncVar]: "A" }, () => {
  // Captures the state at this moment, returning
  // wrapped closure that restores that state.
  wrappedFn = AsyncContext.Snapshot.wrap(fn)
});


console.log(fn()); // => undefined
console.log(wrappedFn()); // => 'A'
```

You can think of this as a more convenient version of `Snapshot`, where only a
single function needs to be wrapped. It also serves as a convenient way for
consumers of libraries that don't support `AsyncContext` to ensure that function
is executed in the correct execution context.

```typescript
// User code that uses a legacy library
const asyncVar = Symbol('asyncVar');
const { get, run } = AsyncContext;

function fn() {
    return get(asyncVar);
}

run({ [asyncVar]: "A" }, () => {
    defer(fn); // setTimeout schedules during "A" context.
})
run({ [asyncVar]: "B" }, () => {
    defer(fn); // setTimeout is not called, fn will still see "A" context.
})
run({ [asyncVar]: "C" }, () => {
    const wrapped = AsyncContext.Snapshot.wrap(fn);
    defer(wrapped); // wrapped callback captures "C" context.
})


// Some legacy library that queues multiple callbacks per macrotick
// Because the setTimeout is called a single time per queue batch,
// all callbacks will be invoked with _that_ context regardless of
// whatever context is active during the call to `defer`.
const queue = [];
function defer(callback) {
    if (queue.length === 0) setTimeout(processQueue, 1);
    queue.push(callback);
}
function processQueue() {
    for (const cb of queue) {
        cb();
    }
    queue.length = 0;
}
```


# Examples

## Determine the initiator of a task

Application monitoring tools like OpenTelemetry save their tracing spans in their the
`AsyncContext.Variable` and retrieve the span when they need to determine what started
this chain of interaction.

These libraries can not intrude the developer APIs for seamless monitoring. The
tracing span doesn't need to be manually passing around by usercodes.

```typescript
// tracer.js

const asyncVar = Symbol('asyncVar');

export function run(cb) {
  // (a)
  const span = {
    startTime: Date.now(),
    traceId: randomUUID(),
    spanId: randomUUID(),
  };
  AsyncContext.run({ [asyncVar]: span }, cb);
}

export function end() {
  // (b)
  const span = AsyncContext.get(asyncVar);
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

User tasks can be scheduled with attributions. Task attributions are propagated in
the async task flow and sub-tasks can be scheduled with the same priority.

```typescript
const scheduler = {
  asyncVar: Symbol('asyncVar'),
  postTask(task, options) {
    // In practice, the task execution may be deferred.
    // Here we simply run the task immediately.
    return AsyncContext.run({ [this.asyncVar]: { priority: options.priority } }, task);
  },
  currentTask() {
    return AsyncContext.get(this.asyncVar) ?? { priority: "default" };
  },
};

const res = await scheduler.postTask(task, { priority: "background" });
console.log(res);

async function task() {
  // Fetch remains background priority by referring to scheduler.currentTask().
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
all values of the scope without access to any of them. This
allows the user-land queue to be implemented in a way that is decoupled from
consumers of the values.

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
    console.log(AsyncContext.get(traceContext));
  });
}

// Tracing libraries can use AsyncContext.Variable to store tracing contexts.
const traceContext = Symbol('traceContext');
AsyncContext.run({ [traceContext]: "trace-id-a" }, userAction);
AsyncContext.run({ [traceContext]: "trace-id-b" }, userAction);

scheduler.runWhenIdle();
// The userTask will be run with the trace context it was enqueued with.
// => 'trace-id-a'
// => 'trace-id-b'
```

# FAQ

## Are there any prior arts?

Please checkout [prior-arts.md][] for more details.

## Why take a function in `run`?

The `Variable.prototype.run` and `Snapshot.prototype.run` methods take a
function to execute because it ensures async context variables
will always contain consistent values in a given execution flow. Any modification
must be taken in a sub-graph of an async execution flow, and can not affect
their parent or sibling scopes.

```typescript
const asyncVar = new Symbol('asyncVar');
AsyncContext.run({ [asyncVar]: "A" }, async () => {
  AsyncContext.get(asyncVar); // => 'A'

  // ...arbitrary synchronous codes.
  // ...or await-ed asynchronous calls.

  // The value can not be modified at this point.
  AsyncContext.get(asyncVar); // => 'A'
});
```

This increases the integrity of async context variables, and makes them
easier to reason about where a value of an async variable comes from.

## How does `AsyncContext` interact with built-in schedulers?

Any time a scheduler (such as `setTimeout`, `addEventListener`, or
`Promise.prototype.then`) runs a user-provided callback, it must choose which
snapshot to run it in. While userland schedulers are free to make any choice
here, this proposal adopts a convention that built-in schedulers will always run
callbacks in the snapshot that was active when the callback was passed to the
built-in (i.e. at "registration time"). This is equivalent to what would happen
if the user explicitly called `AsyncContext.Snapshot.wrap` on all callbacks
before passing them.

This choice is the most consistent with the function-scoped structure that
results from `run` taking a function, and is also the most clearly-defined
option among the possible alternatives.  For instance, many event listeners
may be initiated either programmatically or through user interaction; in the
former case there may be a more recently relevant snapshot available, but it's
inconsistent across different types of events or even different instances of the
same type of event. On the other hand, passing a callback to a built-in function
happens at a very clearly defined time.

Another advantage of registration-time snapshotting is that it is expected to
reduce the amount of intervention required to opt out of the default snapshot.
Because `AsyncContext` is a subtle feature, it's not reasonable to expect every
web developer to build a complete understanding of its nuances. Moreover, it's
important that library users should not need to be aware of the nature of the
variables that library implementations are implicitly passing around. It would
be harmful if common practices emerged that developers felt they needed to wrap
their callbacks before passing them anywhere. The primary means to have a
function run in a different snapshot is to call `Snapshot.wrap`, but this
will be idempotent when passing callbacks to built-ins, making it both less
likely for this common practice to begin in the first place, and also less
harmful when it does happen unnecessarily.

## What if I need access to the snapshot from a more recent cause?

The downside to registration-time snapshotting is that it's impossible to opt
_out_ of the snapshot restoration to access whatever the snapshot would have
been _before_ it was restored. Use cases where this snapshot is more relevant
include

- programmatically-dispatched events whose handlers are installed at application
  initialization time
- unhandled rejection handlers are a specific example of the above
- tracing execution flow, where one task "follows from" a sibling task

As explained above, the alternative snapshot choices are much more specific to
the individual use case, but they can be made available through side channels.
For instance, web specifications could include that certain event types will
expose an `originSnapshot` property (actual name to be determined) on the event
object containing the active `AsyncContext.Snapshot` from a specific point in
time that initiated the event.

Providing these additional snapshots through side channels has several benefits
over switching to them by default, or via a generalized "previous snapshot"
mechanism:

- different types of schedulers may have a variety of potential origination
  points, whose scope can be matched precisely with a well-specified side
  channel
- access via a known side channel avoids loss of idempotency when callbacks are
  wrapped multiple times (whereas a "previous snapshot" would becomes much less
  clear)
- no single wrapper method for developers to build bad habits around

[`asyncresource.runinasyncscope`]:
  https://nodejs.org/dist/latest-v14.x/docs/api/async_hooks.html#async_hooks_asyncresource_runinasyncscope_fn_thisarg_args
[#tc39-async-context]: https://matrix.to/#/#tc39-async-context:matrix.org
[Matrix Guide]: https://github.com/tc39/how-we-work/blob/main/matrix-guide.md
[solution.md]: ./SOLUTION.md
[scoping.md]: ./SCOPING.md
[prior-arts.md]: ./PRIOR-ARTS.md
