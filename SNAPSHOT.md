# Requirements of `AsyncContext.Snapshot`

`AsyncContext.Snapshot` presents two unique requirements:

- It does not expose the value associated with any `Variable` instances.
- It captures _all_ `Variable`s' current value and restores those values
  at a later time.

The above requirements are essential to decouple a queueing implementation
from the consumers of `Variable` instances. For example, a scheduler can queue
an async task and take a snapshot of the current context:

```typescript
// The scheduler doesn't access any AsyncContext.Variable.
const scheduler = {
  queue: [],
  postTask(task) {
    // Each callback is stored with the context at which it was enqueued.
    const snapshot = new AsyncContext.Snapshot();
    queue.push({ snapshot, task });
  },
  runWhenIdle() {
    const queue = this.queue;
    this.queue = [];
    for (const { snapshot, task } of queue) {
      // All tasks in the queue would be run with the current context if they
      // hadn't been wrapped with the snapshot.
      snapshot.run(task);
    }
  }
};
```

In this example, the scheduler can propagate values of `Variable`s but doesn't
have access to any `Variable` instance. They are not coupled with a specific
consumer of `Variable`. A consumer of `Variable` will not be coupled with a
specific scheduler as well.

A consumer like a tracer can use `Variable` without knowing how the scheduler
is implemented:

```typescript
// tracer.js
const asyncVar = new AsyncContext.Variable();
export function run(cb) {
  // Create a new span and run the callback with it.
  const span = {
    startTime: Date.now(),
    traceId: randomUUID(),
    spanId: randomUUID(),
  };
  asyncVar.run(span, cb);
}

export function end() {
  // Get the current span from the AsyncContext.Variable and end it.
  const span = asyncVar.get();
  span?.endTime = Date.now();
}
```

The `Snapshot` API enables user-land queueing implementations to be cooperate
with any consumers of `Variable`. For instances, a queueing implementation can
be:

- A user-land Promise-like implementation,
- A user multiplexer that multiplexes an IO operation with a batch of async
  tasks.

Without an API like `Snapshot`, a queueing implementation would have to be built
on top of the built-in `Promise`, as it is the only way to capture the current
`Variable` values and restore them later. This would limit the implementation
of a user-land queueing.

```typescript
const scheduler = {
  queue: [],
  postTask(task) {
    const { promise, resolve } = Promise.withResolvers();
    // Captures the current context by `Promise.prototype.then`.
    promise.then(() => {
      task();
    });
    // Defers the task execution by resolving the promise.
    queue.push(resolve);
  },
  runWhenIdle() {
    // LIMITATION: the tasks are not run synchronously.
    for (const cb of this.queue) {
      cb();
    }
    this.queue = [];
  }
};
```
