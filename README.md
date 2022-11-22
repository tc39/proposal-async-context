# Async Context for JavaScript

Status: Last presented to TC39 on June 4th, 2020. Consensus for Stage 1 is not
reached yet.

Champions:
- Chengzhong Wu (@legendecas)
- Justin Ridgewell (@jridgewell)

# Motivation

The goal of the proposal is to provide a mechanism to ergonomically track async
contexts in JavaScript. Put another way, it allows propagating a value through
a callstack regardless of any async execution.

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

## **Case 1**: Incomplete error stacks

```typescript
window.onload = e => {
  // (1)
  fetch("https://example.com").then(res => {
    // (2)
    return processBody(res.body).then(data => {
      doSomething(data);
    });
  });
};

function processBody(body) {
  // (3)
  return body.json().then(obj => {
    // (4)
    return obj.data;
  });
}
```

The code snippet above is simple and intuitive. However, if there is one or
other step goes wrong -- not behaving as what we expect, it is hard to root
out the cause of the problem.

What if the `fetch` failed for network issues? In the case, the only error
message we can get in DevTools will be:

```
TypeError: Failed to fetch
    at rejectPromise
```

> V8 introduced [async stack traces][] not before long:
> ```
> GET https://example.com/ net::ERR_TUNNEL_CONNECTION_FAILED
> window.onload	@	(index):13
> load (async)
> (anonymous)	@	(index):12
> ```
> This is wonderful, but it's not the story for most other platforms.

It could be messy for a rather complex project if the error can not be
identified by its error stacks, and more importantly its async cause -- i.e.
where did we get to the error in an async way?

## **Case 2**: Where did we come to here?

```typescript
export async function handler(ctx, next) {
  const span = Tracer.startSpan();
  // First query runs in the synchronous context of the request.
  await dbQuery({ criteria: 'item > 10' });
  // What about subsequent async operations?
  await dbQuery({ criteria: 'item < 10' });
  span.finish();
}

async function dbQuery(query) {
  // How do we determine which request context we are in?
  const span = Tracer.startSpan();
  await db.query(query);
  span.finish();
}
```

In Node.js applications, we can orchestrate many downstream services to provide
a composite data to users. What the thing is, if the application goes a long
unresponsive downtime, it can be hard to determine which step in our app caused
the issue. Node.js experimental builtin module `async_hooks` can be used to
track and maintain a context across the async flow of the request-response.
However, they are not perfect in
[cases](https://gist.github.com/Qard/faad53ba2368db54c95828365751d7bc), and may
get worse while working with `async`/`await` since they are part of the language
and can not be shimmed by third party vendors.

## Summary

Tracked async context across executions of async tasks are useful for debugging,
testing, and profiling. With async context tracked, we can propagate values in
the context along the async flow, in which additional datum can be stored and
fetched  from without additional manual context transferring, like additional
function parameters. Things can be possible without many change of code to
introduce async re-entrance to current libraries.

While monkey-patching is quite straightforward solution to track async tasks,
there is no way to patch JavaScript features like `async`/`await`. Also,
monkey-patching only works if all third-party libraries with custom scheduling
call a corresponding task awareness registration like
[`AsyncResource.runInAsyncScope`][]. Furthermore, for those custom scheduling
third-party libraries, we need to get library owners to think in terms of async
context propagation.

In a summary, we would like to have an async context tracking specification right
in place of ECMAScript for host environments to take advantage of it, and a
standard JavaScript API to enable third-party libraries to work on different
host environments seamlessly.

Priorities:
1. **Must** be able to automatically link continuous async tasks.
1. **Must** provide a way to enable logical re-entrancy.
1. **Must** not collide or introduce implicit behavior on multiple tracking
instance on single async flow.

Non-goals:
1. Async task tracking and monitoring. Giving access to task scheduling in
ECMAScript surfaces concerns from secure ECMAScript environments as it
potentially breaking the scopes that a snippet of code can reach.
1. Error handling & bubbling through async stacks. We'd like to discuss this
topic in a separate proposal since this can be another big story to tell, and
keep this proposal minimal and easy to use for most of the case.
1. Async task interception: This can be a cool feature. But it is easy to cause
confusion if some imported library can take application owner unaware actions
to change the application code running pattern. If there are multiple tracking
instance on same async flow, interception can cause collision and implicit
behavior if these instances do not cooperate well. Thus at this very initial
proposal, we'd like to keep the proposal minimal, and discuss this feature in a
follow up proposal.

# Possible Solution

`AsyncContext` are designed as a value store for context propagation across
multiple logically-connected sync/async operations.

## AsyncContext

```typescript
class AsyncContext<T> {
  static wrap<R>(callback: (...args: any[]) => R): (...args: any[]) => R;

  run<R>(value: T, callback: () => R): R;

  get(): T;
}
```

`AsyncContext.prototype.run()` and `AsyncContext.prototype.get()` sets and gets the current
value of an async execution flow. `AsyncContext.wrap()` allows you to opaquely
capture the current value of all `AsyncContexts` and execute the callback at a
later time with as if those values were still the current values (a snapshot and
restore).

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

> Note: There are controversial thought on the dynamic scoping and `AsyncContext`,
> checkout [SCOPING.md][] for more details.

### Using AsyncContext

#### Time tracker

```typescript
// tracker.js

const context = new AsyncContext();
export function run(cb) {
  // (a)
  context.run({ startTime: Date.now() }, cb);
}

export function elapsed() {
  // (b)
  const elapsed = Date.now() - context.get().startTime;
  console.log('onload duration:', elapsed);
}
```

```typescript
import * as tracker from './tracker.js'

button.onclick = e => {
  // (1)
  tracker.run(() => {
    fetch("https://example.com").then(res => {
      // (2)

      return processBody(res.body).then(data => {
        // (3)

        const dialog = html`<dialog>Here's some cool data: ${data}
                            <button>OK, cool</button></dialog>`;
        dialog.show();

        tracker.elapsed();
      });
    });
  });
};
```

In the example above, `run` and `elapsed` don't share same lexical scope with
actual code functions, and they are capable of async reentrance thus capable of
concurrent multi-tracking.

#### Request Context Maintenance

With AsyncContext, maintaining a request context across different execution
context is possible. For example, we'd like to print a log before each database
query with the request trace id.

First we'll have a module holding the async local instance.

```typescript
// context.js
const context = new AsyncContext();

export function run(ctx, cb) {
  context.run(ctx, cb);
}

export function getContext() {
  return context.getValue();
}
```

With our owned instance of async context, we can set the value on each request
handling call. After setting the context's value, any operations afterwards can
fetch the value with the instance of async context.

```typescript
import { createServer } from 'http';
import { run } from './context.js';
import { queryDatabase } from './db.js';

const server = createServer(handleRequest);

async function handleRequest(req, res) {
  run({ req }, () => {
    // ... do some async work
    // await...
    // await...
    const result = await queryDatabase({ very: { complex: { query: 'NOT TRUE' } } });
    res.statusCode = 200;
    res.end(result);
  });
}
```

So we don't need an additional parameter to the database query functions.
Still, it's easy to fetch the request data and print it.

```typescript
// db.js
import { getContext } from './context.js';
export function queryDatabase(query) {
  const ctx = getContext();
  console.log('query database by request %o with query %o',
              ctx.req.traceId,
              query);
  return doQuery(query);
}
```

In this way, we can have a context value propagated across the async execution
flow and keep track of the value without any other efforts.

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

[async stack traces]: https://v8.dev/docs/stack-trace-api#async-stack-traces
[`AsyncResource.runInAsyncScope`]: https://nodejs.org/dist/latest-v14.x/docs/api/async_hooks.html#async_hooks_asyncresource_runinasyncscope_fn_thisarg_args
[Domain Module Postmortem]: https://nodejs.org/en/docs/guides/domain-postmortem/
[SOLUTION.md]: ./SOLUTION.md
[SCOPING.md]: ./SCOPING.md
