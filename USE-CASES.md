Use cases for `AsyncContext` include:

- Annotating logs with information related to an asynchronous callstack.

- Collecting performance information across logical asynchronous threads of
  control. This includes timing measurements, as well as OpenTelemetry. For
  example, OpenTelemetry's
  [`ZoneContextManager`](https://open-telemetry.github.io/opentelemetry-js/classes/_opentelemetry_context_zone_peer_dep.ZoneContextManager.html)
  is only able to achieve this by using zone.js (see the [prior arts section](./README.md#prior-arts)).

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

## Use Case: Soft Navigation Heuristics

When a user interacts with the page, it's critical that the app feels fast.
But there's no way to determine what started this chain of interaction when
the final result is ready to patch into the DOM tree. The problem becomes
more prominent if the interaction involves with several asynchronous
operations since their original call stack has gone.

```typescript
// Framework listener
doc.addEventListener('click', () => {
  context.run(Date.now(), async () => {
    // User code
    const f = await fetch(dataUrl);
    patch(doc, await f.json());
  });
});
// Some framework code
const context = new AsyncContext();
function patch(doc, data) {
  doLotsOfWork(doc, data, update);
}
function update(doc, html) {
  doc.innerHTML = html;
  // Calculate the duration of the user interaction from the value in the
  // AsyncContext instance.
  const duration = Date.now() - context.get();
}
```

## Use Case: Transitive Task Attributes

Browsers can schedule tasks with priorities attributes. However, the task
priority attribution is not transitive at the moment.

```typescript
async function task() {
  startWork();
  await scheduler.yield();
  doMoreWork();
  // Task attributes are lost after awaiting.
  let response = await fetch(myUrl);
  let data = await response.json();
  process(data);
}

scheduler.postTask(task, {priority: 'background'});
```

The task may include the following attributes:
- Execution priority,
- Fetch priority,
- Privacy protection attributes.

With the mechanism of `AsyncContext` in the language, tasks attributes can be
transitively propagated.

```typescript
const res = await scheduler.postTask(task, {
  priority: 'background',
});
console.log(res);

async function task() {
  // Fetch remains background priority.
  const resp = await fetch('/hello');
  const text = await resp.text();

  // doStuffs should schedule background tasks by default.
  return doStuffs(text);
}

async function doStuffs(text) {
  // Some async calculation...
  return text;
}
```

## Use Case: Userspace telemetry

Application performance monitoring libraries like [OpenTelemetry][] can save
their tracing spans in an `AsyncContext` and retrieves the span when they determine
what started this chain of interaction.

It is a requirement that these libraries can not intrude the developer APIs
for seamless monitoring.

```typescript
doc.addEventListener('click', () => {
  // Create a span and records the performance attributes.
  const span = tracer.startSpan('click');
  context.run(span, async () => {
    const f = await fetch(dataUrl);
    patch(dom, await f.json());
  });
});

const context = new AsyncContext();
function patch(dom, data) {
  doLotsOfWork(dom, data, update);
}
function update(dom, html) {
  dom.innerHTML = html;
  // Mark the chain of interaction as ended with the span
  const span = context.get();
  span?.end();
}
```

### User Interaction

OpenTelemetry instruments user interaction with document elements and connects
subsequent network requests and history state changes with the user
interaction.

The propagation of spans can be achieved with `AsyncContext` and helps
distinguishing the initiators (document load, or user interaction).

```typescript
registerInstrumentations({
  instrumentations: [new UserInteractionInstrumentation()],
});

// Subsequent network requests are associated with the user-interaction.
const btn = document.getElementById('my-btn');
btn.addEventListener('click', () => {
  fetch('https://httpbin.org/get')
    .then(() => {
      console.log('data downloaded 1');
      return fetch('https://httpbin.org/get');
    });
    .then(() => {
      console.log('data downloaded 2');
    });
});
```

Read more at [opentelemetry/user-interaction](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/plugins/web/opentelemetry-instrumentation-user-interaction).

### Long task initiator

Tracking long tasks effectively with the [Long Tasks API](https://github.com/w3c/longtasks)
requires being able to tell where a task was spawned from.

However, OpenTelemetry is not able to associate the Long Task timing entry
with their initiating trace spans. Capturing the `AsyncContext` can help here.

Notably, this proposal doesn't solve the problem solely. It provides a path
forward to the problem and can be integrated into the Long Tasks API.

```typescript
registerInstrumentations([
  instrumentations: [new LongTaskInstrumentation()],
]);
// Roughly equals to
new PerformanceObserver(list => {...})
  .observe({ entryTypes: ['longtask'] });

// Perform a 50ms long task
function myTask() {
  const start = Date.now();
  while (Date.now() - start <= 50) {}
}

myTask();
```

Read more at [opentelemetry/long-task](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/plugins/web/opentelemetry-instrumentation-long-task).

### Resource Timing Attributes

OpenTelemetry instruments fetch API with network timings from [Resource Timing API](https://github.com/w3c/resource-timing/)
associated to the initiator fetch span.

Without resource timing initiator info, it is not an intuitive approach to
associate the resource timing with the initiator spans. Capturing the
`AsyncContext` can help here.

Notably, this proposal doesn't solve the problem solely. It provides a path
forward to the problem and can be integrated into the Long Tasks API.

```typescript
registerInstrumentations([
  new FetchInstrumentation(),
]);
// Observes network events and associate them with spans.
new PerformanceObserver(list => {
  const entries = list.getEntries();
  spans.forEach(span => {
    const entry = entries.find(it => {
      return it.name === span.name && it.startTime >= span.startTime;
    });
    span.recordNetworkEvent(entry);
  });
}).observe({ entryTypes: ['resource'] });
```

Read more at [opentelemetry/fetch](https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/opentelemetry-instrumentation-fetch).

[OpenTelemetry]: https://github.com/open-telemetry/opentelemetry-js
