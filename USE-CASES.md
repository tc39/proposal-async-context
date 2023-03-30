Use cases for `AsyncContext` include:

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
