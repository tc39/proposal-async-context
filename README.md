# Async Context for JavaScript

Status: Last presented to TC39 on June 4th, 2020. Consensus for Stage 1 is not
reached yet.

# Motivation

The goal of the proposal is to provide a mechanism to ergonomically track async
contexts in JavaScript.

There are multiple implementations in different platforms and frameworks like
`async_hooks` in Node.js and `zones.js` in Angular that provides async contexts
and async tasks tracking. These modules works well on their own platform/impl,
however they are not in quite same per API shapes compared with each other.
Library owners might have to adopt both two, or more, to keep a persistent
async context across async tasks execution.

So what is async contexts? We will take following code snippet as an example:

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

At all six marked points, the "async context" is the same: we're in an "async
context" originating from the `load` event on `window`. Note how `(3)` and
`(4)` are outside the lexical context, but is still part of the same "async
stack". And note how the promise chain does not suffice to capture this notion
of async stack, as shown by `(6)`.

The code snippet above is simple and intuitive. However, if there is one or
other step goes wrong -- not behaving as what we expect, it is hard to root
out the cause of the problem.

## **Case 1**: Incomplete error stacks

What if the `fetch` failed for network issues? In the case, the only error
message we can get in DevTools will be:

```
TypeError: Failed to fetch
    at rejectPromise
```

> V8 introduced [async stack traces]() not before long:
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
[`AsyncResource.runInAsyncScope`](). Furthermore, for those custom scheduling
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

`AsyncLocal`s are meant to help with the problems of tracking asynchronous
logical contexts. They are designed as a value store for context propagation
across multiple logically-connected async operations.

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

The value in `AsyncLocal` propagates forward along with the async execution
flow.

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

Similar to above example of the additional function parameter "context",
`AsyncLocal` propagates values to its child async-execution-context.
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

As the value of `AsyncLocal` can be fetched from its own store, i.e. the
`AsyncLocal` object, from arbitrary execution context in an async execution
flow, users of async local have to declare their own `AsyncLocal` to get
their value propagates with async execution flow.

### Using `AsyncLocal`

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

button.onclick = e => {
  // (1)
  tracker.start();

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

In the example above, `trackStart` and `trackEnd` don't share same lexical
scope with actual code functions, and they are capable of async reentrance thus
capable of concurrent multi-tracking.

#### Request Context Maintenance

With `AsyncLocal`, maintaining a request context across different execution
context is possible. For example, we'd like to print a log before each database
query with the request trace id.

First we'll have a module holding the async local instance.

```js
//
const asyncLocal = new AsyncLocal();

export function setContext(ctx) {
  asyncLocal.setValue(ctx);
}

export function getContext() {
  return asyncLocal.getValue();
}
```

With the our owned instance of async local, we can set the value on each
request handling call. After set the context, any operations afterwards can
fetch the context with the instance of async local.

```js
import { createServer } from 'http';
import { setContext } from './context';
import { queryDatabase } from './db';

const server = createServer(handleRequest);

async function handleRequest(req, res) {
  setContext({ req });
  // ... do some async work
  // await...
  // await...
  const result = await queryDatabase({ very: { complex: { query: 'NOT TRUE' } } });
  res.statusCode = 200;
  res.end(result);
}
```

So we don't need an additional parameter to the database query functions.
Still, it's easy to fetch the request data and print it.

```js
import { getContext } from './context';
// some module
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

## AsyncTask

<!--
TODO: how do we determine a task is not going to be used anymore?

Fundamentally if an object is going to be finalized, it can not be used afterward.
If an async task says it is disposed, `runInAsyncScope` throws once disposed.
-->

While multiplexing platform provided async resources is not a rare case,
how does the async locals get properly propagated?

For library owners, `AsyncTask`s are preferred to indicate new synthetic async
tasks' schedule.

```js
class AsyncTask {
  constructor();
  runInAsyncScope(callback[, thisArg, ...args]);
}
```

`AsyncTask.runInAsyncScope` calls the provided function with the provided
arguments in the execution context of the async task. This will establish
the context, call the function, and then restore the original async execution
context.

### Using `AsyncTask`

```js
class DatabaseConnection {
  constructor(port, host) {
    // Initialize connection, possibly in root context.
    this.socket = connect(port, host)
  }

  async query(search) {
    const task = new Query(search)
    const result = await this.socket.send(query)
    // This async context is triggered by `DatabaseConnection` which is
    // not linked to initiator of `DatabaseConnection.query`.
    return task.runInAsyncScope(() => {
      // Promise linked to the initiator of `DatabaseConnection.query`.
      // Promise -> QueryTask -> `DatabaseConnection.query`
      return Promise.resolve(result)
    })
  }
}

class QueryTask extends AsyncTask {
  constructor(search) {
    // scheduled async task
    super()
    this.search = search
  }
}
```

In the example above, `DatabaseConnection` can be established at root execution
context (or any other context). With `AsyncTask`, each call to
`DatabaseConnection.query` will schedule an async task, which will be linked
to its initiator execution context (may not be the one establishing
`DatabaseConnection`). And at the resolution of socket, the contexts are
propagated by the `DatabaseConnection`, which is linked to its initiating
execution context, so the context has to be re-established by
`AsyncTask.runInAsyncScope`.

In this way, we can propagate correct async context flows on multiplexing
single host platform provided async resource.

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

```js
const loadZone = Zone.current.fork({ name: "loading zone" });
window.onload = loadZone.wrap(e => { ... });
```

then at all those sites, `Zone.current` would be equal to `loadZone`.

Compared to this proposal, `Zone` acts similar to the `AsyncTask` object in
this proposal. However, there are differences of the basic concept between
those two definitions. `AsyncTask`s declare a logical connection between
multiple asynchronously executions.

## Node.js `domain` module

Domain's global central active domain can be consumed by multiple endpoints
and be exchanged in any time with synchronous operation (`domain.enter()`).
Since it is possible that some third party module changed active domain on
the fly and application owner may unaware of such change, this can introduce
unexpected implicit behavior and made domain diagnosis hard.

Check out [Domain Module Postmortem]() for more details.

## Node.js `async_hooks`

This is what the proposal evolved from. `async_hooks` in Node.js enabled async
resources tracking for APM vendors. On which Node.js also implemented
`AsyncLocalStorage`.

[async stack traces]: https://v8.dev/docs/stack-trace-api#async-stack-traces
[`AsyncResource.runInAsyncScope`]: https://nodejs.org/dist/latest-v14.x/docs/api/async_hooks.html#async_hooks_asyncresource_runinasyncscope_fn_thisarg_args
[Domain Module Postmortem]: https://nodejs.org/en/docs/guides/domain-postmortem/
