# Async Context for JavaScript

Status: Stage 2

Champions:
- Chengzhong Wu (@legendecas)
- Justin Ridgewell (@jridgewell)

# Motivation

The goal of the proposal is to provide a mechanism to ergonomically track async
contexts in JavaScript. Put another way, it allows propagating a value through
a callstack regardless of any async execution, without needing to explicitly
pass the value from task to task.

Use cases for this include:

- Annotating logs with information related to an asynchronous callstack.

- Collecting performance information across logical asynchronous threads of
  control. This includes timing measurements, as well as OpenTelemetry. For
  example, OpenTelemetry's
  [`ZoneContextManager`](https://open-telemetry.github.io/opentelemetry-js/classes/_opentelemetry_context_zone_peer_dep.ZoneContextManager.html)
  is only able to achieve this by using zone.js (see the prior art section
  below).

- Web APIs such as
  [Prioritized Task Scheduling](https://wicg.github.io/scheduling-apis) let
  users schedule a task in the event loop with a given priority. However, this
  only affects that task's priority, so users might need to propagate that
  priority, particularly into promise jobs and callbacks.

  Furthermore, having a way to keep track of async control flows in the JS
  engine would allow these APIs to make the priority of such a task transitive,
  so that it would automatically be used for any tasks/jobs originating from it.

- There are a number of use cases for browsers to track the attribution of tasks
  in the event loop, even though an asynchronous callstack. They include:

  - Optimizing the loading of critical resources in web pages requires tracking
    whether a task is transitively depended on by a critical resource.

  - Tracking long tasks effectively with the
    [Long Tasks API](https://w3c.github.io/longtasks) requires being able to
    tell where a task was spawned from.

  - [Measuring the performance of SPA soft navigations](https://developer.chrome.com/blog/soft-navigations-experiment/)
    requires being able to tell which task initiated a particular soft
    navigation.

Hosts are expected to use the infrastructure in this proposal to allow tracking
not only asynchronous callstacks, but other ways to schedule jobs on the event
loop (such as `setTimeout`) to maximize the value of these use cases.

## A use case in depth: logging

It's easiest to explain this in terms of setting and reading a global variable
in sync execution. Imagine we're a library which provides a simple `log` and
`run` function. Users may pass their callbacks into our `run` function and an
arbitrary "id". The `run` will then invoke their callback and while running, the
developer may call our `log` function to annotate the logs with the id they
passed to the run.

```typescript
let currentId = undefined;

export function log() {
  if (currentId === undefined) throw new Error('must be inside a run call stack');
  console.log(`[${currentId}]`, ...arguments);
}

export function run<T>(id: string, cb: () => T) {
  let prevId = currentId;
  try {
    currentId = id;
    return cb();
  } finally {
    currentId = prevId;
  }
}
```

The developer may then use our library like this:

```typescript
import { run, log } from 'library';
import { helper } from 'some-random-npm-library';

document.body.addEventListener('click', () => {
  const id = new Uuid();

  run(id, () => {
    log('starting');

    // Assume helper will invoke doSomething.
    helper(doSomething);

    log('done');
  });
});

function doSomething() {
  log("did something");
}
```

In this example, no matter how many times a user may click, we'll also see a
perfect "[123] starting", "[123] did something" "[123] done" log. We've
essentially implemented a synchronous context stack, able to propagate the `id`
down through the developers call stack without them needing to manually pass or
store the id themselves.  This pattern is extremely useful. It is not always
ergonomic (or even always possible) to pass a value through every function call
(think of passing React props through several intermediate components vs passing
through a React [Context](https://reactjs.org/docs/context.html)).

However, this scenario breaks as soon as we introduce any async operation into
our call stack.

```typescript
document.body.addEventListener('click', () => {
  const id = new Uuid();

  run(id, async () => {
    log('starting');

    await helper(doSomething);

    // This will error! We've lost our id!
    log('done');
  });
});

function doSomething() {
  // Will this error? Depends on if `helper` awaited before calling.
  log("did something");
}
```

`AsyncContext` solves this issue, allowing you to propagate the id through both
sync and async execution by keeping track of the context in which we started the
execution.

```typescript
const context = new AsyncContext();

export function log() {
  const currentId = context.get();
  if (currentId === undefined) throw new Error('must be inside a run call stack');
  console.log(`[${currentId}]`, ...arguments);
}

export function run<T>(id: string, cb: () => T) {
  context.run(id, cb);
}
```

## Summary

This proposal introduces APIs to propagate a value through asynchronous
hop or continuation, such as a promise continuation or async callbacks.

Non-goals:
1. Async tasks scheduling and interception.
1. Error handling & bubbling through async stacks.

# Proposed Solution

`AsyncContext` are designed as a value store for context propagation across
multiple logically-connected sync/async operations.

```typescript
class AsyncContext<T> {
  static wrap<R>(callback: (...args: any[]) => R): (...args: any[]) => R;

  run<R>(value: T, callback: () => R): R;

  get(): T;
}
```

`AsyncContext.prototype.run()` and `AsyncContext.prototype.get()` sets and gets the current
value of an async execution flow. `AsyncContext.wrap()` allows you to opaquely
capture the current value of all `AsyncContext`s and execute the callback at a
later time with as if those values were still the current values (a snapshot and
restore). Note that even with `AsyncContext.wrap()`, you can only access the
value associated with an `AsyncContext` instance if you have access to that instance.

```typescript
const context = new AsyncContext();

// Sets the current value to 'top', and executes the `main` function.
context.run('top', main);

function main() {
  // Context is maintained through other platform queueing.
  setTimeout(() => {
    console.log(context.get()); // => 'top'

    context.run('A', () => {
      console.log(context.get()); // => 'A'

      setTimeout(() => {
        console.log(context.get()); // => 'A'
      }, randomTimeout());
    });
  }, randomTimeout());

  // Context runs can be nested.
  context.run('B', () => {
    console.log(context.get()); // => 'B'

    setTimeout(() => {
      console.log(context.get()); // => 'B'
    }, randomTimeout());
  });

  // Context was restored after the previous run.
  console.log(context.get()); // => 'top'

  // Captures the state of all AsyncContext's at this moment.
  const snapshotDuringTop = AsyncContext.wrap((cb) => {
      console.log(context.get()); // => 'top'
      cb();
  });


  // Context runs can be nested.
  context.run('C', () => {
    console.log(context.get()); // => 'C'

    // The snapshotDuringTop will restore all AsyncContext to their snapshot
    // state and invoke the wrapped function. We pass a callback which it will
    // invoke.
    snapshotDuringTop(() => {
      // Despite being lexically nested inside 'C', the snapshot restored us to
      // to the 'top' state.
      console.log(context.get()); // => 'top'
    });
  });
}

function randomTimeout() {
  return Math.random() * 1000;
}
```

`AsyncContext.wrap` is useful for implementing APIs that logically "schedule" a
callback, so the callback will be called with the context that it logically
belongs to, regardless of the context under which it actually runs:

```typescript
let queue = [];

export function enqueueCallback(cb: () => void) {
  // Each callback is stored with the context at which it was enqueued.
  queue.push(AsyncContext.wrap(cb));
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

> Note: There are controversial thought on the dynamic scoping and `AsyncContext`,
> checkout [SCOPING.md][] for more details.

# Examples

## Determine the initiator of a task

Application monitoring tools like OpenTelemetry save their tracing spans in the
`AsyncContext` and retrieve the span when they need to determine what started
this chain of interaction.

These libraries can not intrude the developer APIs for seamless monitoring.
The tracing span doesn't need to be manually passing around by usercodes.

```typescript
// tracer.js

const context = new AsyncContext();
export function run(cb) {
  // (a)
  const span = {
    startTime: Date.now(),
    traceId: randomUUID(),
    spanId: randomUUID(),
  };
  context.run(span, cb);
}

export function end() {
  // (b)
  const span = context.get();
  span?.endTime = Date.now();
}
```

```typescript
// my-app.js
import * as tracer from './tracer.js'

button.onclick = e => {
  // (1)
  tracer.run(() => {
    fetch("https://example.com").then(res => {
      // (2)

      return processBody(res.body).then(data => {
        // (3)

        const dialog = html`<dialog>Here's some cool data: ${data}
                            <button>OK, cool</button></dialog>`;
        dialog.show();

        tracer.end();
      });
    });
  });
};
```

In the example above, `run` and `end` don't share same lexical scope with
actual code functions, and they are capable of async reentrance thus capable of
concurrent multi-tracking.

## Transitive task attribution

User tasks can be scheduled with attributions. With `AsyncContext`, task
attributions are propagated in the async task flow and sub-tasks can be
scheduled with the same priority.

```typescript
const scheduler = {
  context: new AsyncContext(),
  postTask(task, options) {
    // In practice, the task execution may be deferred.
    // Here we simply run the task immediately with the context.
    this.context.run({ priority: options.priority }, task);
  },
  currentTask() {
    return this.context.get() ?? { priority: 'default' };
  },
};

const res = await scheduler.postTask(task, { priority: 'background' });
console.log(res);

async function task() {
  // Fetch remains background priority by referring to scheduler.currentPriority().
  const resp = await fetch('/hello');
  const text = await resp.text();

  scheduler.currentTask(); // => { priority: 'background' }
  return doStuffs(text);
}

async function doStuffs(text) {
  // Some async calculation...
  return text;
}
```

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

The concept of the _current zone_, reified as `Zone.current`, is crucial.
Both `run` and `wrap` are designed to manage running the current zone:

- `z.run(callback)` will set the current zone to `z` for the duration of
`callback`, resetting it to its previous value afterward. This is how you
"enter" a zone.
- `z.wrap(callback)` produces a new function that essentially performs
`z.run(callback)` (passing along arguments and this, of course).

The _current zone_ is the async context that propagates with all our
operations. In our above example, sites `(1)` through `(6)` would all have
the same value of `Zone.current`. If a developer had done something like:

```typescript
const loadZone = Zone.current.fork({ name: "loading zone" });
window.onload = loadZone.wrap(e => { ... });
```

then at all those sites, `Zone.current` would be equal to `loadZone`.

## Node.js `domain` module

Domain's global central active domain can be consumed by multiple endpoints
and be exchanged in any time with synchronous operation (`domain.enter()`).
Since it is possible that some third party module changed active domain on
the fly and application owner may unaware of such change, this can introduce
unexpected implicit behavior and made domain diagnosis hard.

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
`Task.run()` restores the saved call stack and append it to newly generated
call stacks.

```console
Error: Call stack
  at someTask (example.js)
  at loop (framework.js)          // <- Task.run
  at async someTask               // <- Async stack appended
  at schedule (framework.js)      // <- console.createTask
  at businessLogic (example.js)
```

[async stack traces]: https://v8.dev/docs/stack-trace-api#async-stack-traces
[`AsyncResource.runInAsyncScope`]: https://nodejs.org/dist/latest-v14.x/docs/api/async_hooks.html#async_hooks_asyncresource_runinasyncscope_fn_thisarg_args
[Domain Module Postmortem]: https://nodejs.org/en/docs/guides/domain-postmortem/
[SOLUTION.md]: ./SOLUTION.md
[SCOPING.md]: ./SCOPING.md
[Async Stack Tagging API]: https://developer.chrome.com/blog/devtools-modern-web-debugging/#linked-stack-traces
