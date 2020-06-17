# Async Context for JavaScript

Status: This proposal has not been presented to TC39 yet.

# Motivation

The goal of the proposal is to provide a mechanism to ergonomically track async tasks in JavaScript.

There are multiple implementations in different platforms like `async_hooks` in Node.js and `zones.js`
in Angular that provides async task tracking. These modules works well on their own platform/impl, however
they are not in quite same with each other. Library owners have to adopt both two, or more, to keep a
persistent async context across async tasks execution.

We will take following code snippet as an example:

```js
window.onload = e => {
  // (1)
  fetch("https://example.com").then(res => {
    // (2)
    return processBody(res.body).then(data => {
      // (5)
      const dialog = html`<dialog>Here's some cool data: ${data}
                          <button>OK, cool</button></dialog>`;
      dialog.show();

      dialog.querySelector("button").onclick = () => {
        // (6)
        dialog.close();
      };
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

At all six marked points, the "async context" is the same: we're in an "async context" originating from the
`load` event on `window`. Note how `(3)` and `(4)` are outside the lexical context, but is still part of the
same "async stack". And note how the promise chain does not suffice to capture this notion of async stack, as
shown by `(6)`.

The code snippet above is simple and intuitive. However, if there is one or other step goes wrong -- not behaving
as what we expect, it is hard to root out the cause of the problem:

## **Case 1**: Incomplete error stacks

What if the `fetch` failed for network issues? In the case, the only error message we can get in DevTools will be:

```
TypeError: Failed to fetch
    at rejectPromise
```

> Note: V8 introduced [async stack traces](https://v8.dev/docs/stack-trace-api#async-stack-traces) not before long:
> ```
> GET https://example.com/ net::ERR_TUNNEL_CONNECTION_FAILED
> window.onload	@	(index):13
> load (async)
> (anonymous)	@	(index):12
> ```
> This is wonderful, but it's not the story for most other platforms.

It could be messy for a rather complex project if the error can not be identified by its stacks, and more importantly
its async cause -- i.e. where did we get to the error in an async way?

## **Case 2**: Where did we come to here?

```js
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

In Node.js applications, we can orchestrate many downstream services to provide a composite
data to users. What the thing is, if the application goes a long unresponsive downtime,
it can be hard to determine which step in our app caused the issue. There are implementations like
`async_hooks` in Node.js can be used to track and maintain a context across the async flow of the
request-response. However, they are not perfect in
[cases](https://gist.github.com/Qard/faad53ba2368db54c95828365751d7bc), and may get worse while
working with `async`/`await` since they are part of the language and can not be shimmed by third party
vendors.

## **Case 3**: Leaking tasks

Although promises and `async`/`await` are not very new to us, and we have many experience of how to use
these features correctly. It can be still going unnoticed if `await` or `return` is not correctly annotated
or exceptions are thrown in a separate execution context.

```js
test(async () => {
  // How to early fail the case with this leaking task?
  /** await */ asyncOperation();
});

test(() => {
  // How to early fail the case with this leaking task?
  setTimeout(() => {
    throw new Error('foobar');
  }, 1000);
});
```

There might be tools endeavored to prevent the missing `await` case like TypeScript. But in the second
leaking exception case, it is still undetectable if the path is very deep and complex, and it can fail
another unrelated test case, which can be frustrating.

## Summary

Tracked async tasks are useful for debugging, testing, and profiling. With async tasks tracked, we can
properly propagate async locals along the async flow, in which additional datum can be stored
and fetched from without additional manual context transferring. It can be possible without many change
of code to introduce async re-entrance to current libraries.

Moreover, with the async task tracking, it is possible to determine what tasks have been scheduled during
a period of code evaluation, and do something additional on schedule changes, e.g. asserting there is no
outstanding async task on end of a test case.

While monkey-patching is quite straightforward solution to track async tasks, there is no way to patch
JavaScript features like `async`/`await`. Also, monkey-patching only works if all third-party libraries
with custom scheduling call a corresponding task awareness registration like
[`AsyncResource.runInAsyncScope`](https://nodejs.org/dist/latest-v14.x/docs/api/async_hooks.html#async_hooks_asyncresource_runinasyncscope_fn_thisarg_args).
Furthermore, for those custom scheduling third-party libraries, we need to get library owners to think in
terms of async context propagation.

In a summary, we would like to have an async task tracking specification right in place of ECMAScript
for host environments to take advantage of it, and a standard JavaScript API to enable third-party
libraries to work on different host environments seamlessly.

Priorities (not necessarily in order):
1. **Must** be able to automatically link continuous async tasks.
1. **Must** provide a way to enable logical re-entrancy.
1. **Must** not collide or introduce implicit behavior on multiple tracking instance on single async flow.
1. **Should** expose visibility into the async task scheduling and processing.

Non-goals:
1. Error handling & bubbling through async stacks. We'd like to discuss this topic in a separate proposal
since this can be another big story to tell, and keep this proposal minimal and easy to use for most of
the case.
2. Async task interception: This can be a cool feature. But it is easy to cause confusion if some imported
library can take application owner unaware actions to change the application code running pattern. If
there are multiple tracking instance on same async flow, interception can cause collision and implicit
behavior if these instances do not cooperate well. Thus at this very initial proposal, we'd like to keep the
proposal minimal, and discuss this feature in a follow up proposal.

# Possible Solution

`AsyncLocalStorage`s are meant to help with the problems of tracking asynchronous code.
They are designed as a primitive for context propagation across multiple logically-connected async operations.

In this proposal, we are not manipulating of the logical concept with `AsyncLocalStorage` and `AsyncHook`, but
a side router to monitor what happened around the async context changes. On top of this, in this proposal, and
other work, perhaps outside of JavaScript, can build on this base association. Such work can accomplish things like:

- Automatically tracking outstanding async operations within a given "logical async context", to perform cleanup or
rendering or test assertion steps afterwards.
- Timing the total time spent in a "logical async context", for analytics or in-the-field profiling.

## AsyncLocal

```js
class AsyncLocal<T = any> {
  constructor(valueChangedListener: ValueChangedListener<T>);
  getValue(): T;
  setValue(value: T);
}

type ValueChangedListener<T> = (newValue: T, prevValue: T, isExplicitSet: bool);
```

`AsyncLocal.getValue()` returns the current value of the context.

An `AsyncLocal` has similar semantics of function parameters. The point is that
`AsyncLocal` can be fetched from its own registry, i.e. the `AsyncLocal`
object, from arbitrary execution context along side the async execution flow.

```js
async function root(context) {
  console.log(context); // => 'foo'
  context = 'bar';
  await next(context);
  console.log(context) // => 'bar'
}

async function next(context) {
  context = 'quz';
  console.log(context); // => 'quz'
}

const context = 'foo';
await root(context);
console.log(context); // => 'foo'
```

Similarly, `AsyncLocal` propagates values to its child async-execution-context.
However the values set in child async execution context will not be feed back
to its parent async execution context.

```js
const context = new AsyncLocal();

context.setValue('foo');
await root();
console.log(context.getValue()); // => 'foo'

async function root() {
  console.log(context.getValue()); // => 'foo'
  context.setValue('bar');
  await next(context);
  console.log(context.getValue()); // => 'bar'
  sync();
  console.log(context.getValue()); // => 'baz'
}

function sync() {
  context.setValue('baz');
  console.log(context.getValue()); // => 'baz'
}

async function next() {
  context.setValue('quz');
  console.log(context.getValue()); // => 'quz'
}
```


### Using `AsyncLocal`

<!--
Since async local storage is namespaced in the example: we don't have a global store/context
effective by default.
Users of async local storage have to declare their own store with their own store/context.
Async pattern does work, yet sync one can be adopt more seamlessly to existing codes.
-->

#### Time tracker

```js
// tracker.js

const asyncLocal = new AsyncLocal();
export function start() {
  // (a)
  store.setValue({ startTime: Date.now() });
}
export function end() {
  // (b)
  const dur = Date.now() - store.getValue().startTime;
  console.log('onload duration:', dur);
}
```

```js
import * as tracker from './tracker.js'

window.onload = e => {
  // (1)
  tracker.start()

  fetch("https://example.com").then(res => {
    // (2)

    return processBody(res.body).then(data => {
      // (3)

      const dialog = html`<dialog>Here's some cool data: ${data}
                          <button>OK, cool</button></dialog>`;
      dialog.show();

      tracker.end();
    });
  });
};
```

In the example above, `trackStart` and `trackEnd` don't share same lexical scope with actual code functions,
and they are capable of reentrance thus capable of concurrent multi-tracking.

Although `asyncLocalStorage.enterWith` is a sync operation, it is not shared automatically and globally and
doesn't have any side effects on other modules.

## AsyncTask

<!--
TODO: how do we determine a task is not going to be used anymore?

Fundamentally if an object is going to be finalized, it can not be used afterward.
If an async task says it is disposed, `runInAsyncScope` throws once disposed.
-->

For library owners, `AsyncTask`s are preferred to indicate new async tasks' schedule.

```js
class AsyncTask {
  constructor(name);

  get name;

  runInAsyncScope(callback[, thisArg, ...args]);
}
```

`AsyncTask.runInAsyncScope` calls the provided function with the provided arguments in the execution context
of the async task. This will establish the context, trigger the `AsyncHook`s before callbacks, call the function,
trigger the `AsyncHook`s after callbacks, and then restore the original execution context.

### Using `AsyncTask`

```js
class DatabaseConnection {
  constructor(port, host) {
    // Initialize connection, possibly in root context.
    this.socket = connect(port, host)
  }

  async query(search) {
    const query = new Query(search)
    const result = await this.socket.send(query)
    // This async context is triggered by `DatabaseConnection` which is not linked to initiator of `DatabaseConnection.query`.
    return query.runInAsyncScope(() => {
      // Promise linked to the initiator of `DatabaseConnection.query`.
      // Promise -> Query(AsyncTask) -> `DatabaseConnection.query`
      return Promise.resolve(result)
    })
  }
}

class Query extends AsyncTask {
  constructor(search) {
    // scheduled async task
    super('database-query')
    this.search = search
  }
}
```

In the example above, `DatabaseConnection` can be established at root execution context (or any other context). With `AsyncTask`,
each call to `DatabaseConnection.query` will schedule an async task, which will be linked to its initiator execution context (may
not be the one establishing `DatabaseConnection`). And at the resolution of socket, the contexts are propagated by the `DatabaseConnection`,
which is linked to its initiating execution context, so the context has to be re-established by `AsyncTask.runInAsyncScope`.

In this way, we can propagate correct async context flows on multiplexing single async task.

# Prior Arts

## zones.js
Zones proposed a `Zone` object, which has the following API:

```js
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

The concept of the _current zone_, reified as `Zone.current`, is crucial. Both `run` and `wrap` are designed to manage running the current zone:

- `z.run(callback)` will set the current zone to `z` for the duration of `callback`, resetting it to its previous value afterward. This is how you "enter" a zone.
- `z.wrap(callback)` produces a new function that essentially performs `z.run(callback)` (passing along arguments and this, of course).

The _current zone_ is the async context that propagates with all our operations. In our above example, sites `(1)` through `(6)` would all have the same value of `Zone.current`. If a developer had done something like:

```js
const loadZone = Zone.current.fork({ name: "loading zone" });
window.onload = loadZone.wrap(e => { ... });
```

then at all those sites, `Zone.current` would be equal to `loadZone`.

Zones in `zones.js` are basically `AsyncHook`, `AsyncLocalStorage` and `AsyncTask` merged in this proposal. The
reason we'd like to split the concept of `Zone` and `AsyncTask` is that they don't share target users in most cases.
`AsyncTask`s are generally made interests of third-party scheduling libraries, while `AsyncHook` and `AsyncLocalStorage`
are expected to be intuitive to most JavaScript users.

## Node.js `domain` module

Domain's global central active domain can be consumed by multiple endpoints and be exchanged in any time with
synchronous operation (`domain.enter()`). Since it is possible that some third party module changed active domain on the fly and application owner may unaware of such change, this can introduce unexpected implicit behavior and made domain diagnosis hard.

Check out [Domain Module Postmortem](https://nodejs.org/en/docs/guides/domain-postmortem/) for more details.

## Node.js `async_hooks`

This is what the proposal evolved from. `async_hooks` in Node.js enabled async resources tracking for APM vendors. On which Node.js also implemented `AsyncLocalStorage`.
