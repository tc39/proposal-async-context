# Async Context for JavaScript

Status: Last presented to TC39 on June 4th, 2020. Consensus for Stage 1 is not
reached yet.

Champions:
- Chengzhong Wu (@legendecas)
- Justin Ridgewell (@jridgewell)

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

## **Case 1**: Incomplete error stacks

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

AsyncLocals are meant to help with the problems of tracking asynchronous
logical contexts. They are designed as a value store for context propagation
across multiple logically-connected async operations.

## AsyncLocal

```js
class AsyncLocal<T = any> {
  constructor(valueChangedListener?: ValueChangedListener<T>);
  getValue(): T;
  setValue(value: T);
}

type ValueChangedListener<T> = (newValue: T, prevValue: T) => void;
```

`AsyncLocal.getValue()` returns the current value of the async execution flow.

As the value of AsyncLocal has to be fetched from its own store, i.e. the
AsyncLocal object. From arbitrary execution context in an async execution
flow, users have to declare their own AsyncLocal to get their value
propagates along with an async execution flow.

AsyncLocal propagates values along the logical async execution flow.

```js
const asyncLocal = new AsyncLocal();

(function main() {
  asyncLocal.setValue('main');

  setTimeout(() => {
    console.log(asyncLocal.getValue()); // => 'main'
    asyncLocal.setValue('first timer');
    setTimeout(() => {
      console.log(asyncLocal.getValue()); // => 'first timer'
    }, 1000);
  }, 1000);

  setTimeout(() => {
    console.log(asyncLocal.getValue()); // => 'main'
    asyncLocal.setValue('second timer');
    setTimeout(() => {
      console.log(asyncLocal.getValue()); // => 'second timer'
    }, 1000);
  }, 1000);
})();
```

> Note: There are controversial thought on the dynamic scoping and AsyncLocal,
> checkout [SCOPING.md][] for more details.

The optional `valueChangedListener` will be called each time the value in the
current async flow has been updated by explicit `AsyncLocal.setValue` call. It
can be treated as a property setter of an object.

The motivation for the `valueChangedListener` is that we can have a cleaner way
to monitor the value changes of an AsyncLocal without any `setValue` wrappers.

As the `valueChangedListener` is only going to be trigger by explicit value
set, codes where can trigger the `valueChangedListener` is strictly restricted
since the code where trigger the listener has to explicitly refer to the
instance of AsyncLocal.

```js
const asyncLocal = new AsyncLocal(
  (newValue, prevValue) =>
    console.log(`valueChanged: newValue(${newValue}), prevValue(${prevValue})`)
);

// Evaluate the `run` function twice asynchronously.
Promise.resolve().then(run);
Promise.resolve().then(run);

async function run() {
  // (1)
  asyncLocal.setValue('foo');
  await sleep(1000);
  await next(asyncLocal);
  // (3)
  asyncLocal.setValue('quz');
}

async function next() {
  // (2)
  asyncLocal.setValue('bar');
  await sleep(1000);
}
```

The output of above snippet will be

```log
// (1)
valueChanged: newValue('foo'), prevValue(undefined);
valueChanged: newValue('foo'), prevValue(undefined);
// (2)
valueChanged: newValue('bar'), prevValue('foo');
valueChanged: newValue('bar'), prevValue('foo');
// (3)
valueChanged: newValue('quz'), prevValue('bar');
valueChanged: newValue('quz'), prevValue('bar');
```

Read more about the detailed behaviors definition of AsyncLocal at
[SOLUTION.md][].

### Using AsyncLocal

#### Time tracker

```js
// tracker.js

const asyncLocal = new AsyncLocal();
export function start() {
  // (a)
  asyncLocal.setValue({ startTime: Date.now() });
}
export function end() {
  // (b)
  const dur = Date.now() - asyncLocal.getValue().startTime;
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

With AsyncLocal, maintaining a request context across different execution
context is possible. For example, we'd like to print a log before each database
query with the request trace id.

First we'll have a module holding the async local instance.

```js
// context.js
const asyncLocal = new AsyncLocal();

export function setContext(ctx) {
  asyncLocal.setValue(ctx);
}

export function getContext() {
  return asyncLocal.getValue();
}
```

With our owned instance of async local, we can set the value on each
request handling call. After set the context, any operations afterwards can
fetch the context with the instance of async local.

```js
import { createServer } from 'http';
import { setContext } from './context.js';
import { queryDatabase } from './db.js';

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
arguments in the async context of the async task. This will establish
the async context, call the function, and then restore the original async
context.

### Using `AsyncTask`

```js
// Callback based arbitrary asynchronous API.
function connect(port, host) {
  let nextId = 0;
  const requestResponseMap = new Map();

  // Establish the connection, the client is linked to the current async context.
  const client = net.createConnection({ host, port });
  client.on('connect', () => {
    console.log('connected to server');
  });
  client.on('end', () => {
    console.log('disconnected from server');
  });

  // the client is created at the async context of `connect`,
  // the listeners will be triggered at the async context of the
  // client initiating async context.
  client.on('data', (res) => {
    const { id, data } = JSON.parse(res.toString('utf8'));
    const req = requestResponseMap.get(id);
    if (req == null) {
      console.log('unknown response with id(%s)', id);
      return;
    }

    // The req.handler callback is called under the async context of client
    // listeners.
    req.handler(data);
  });
  return {
    send: (data, handler) => {
      const id = nextId++;
      client.write(JSON.stringify({ id, data }));
      requestResponseMap.set(id, { handler });
    }
  }
}

// AsyncTask & Promise based connection wrapper.
class DatabaseConnection {
  constructor(port, host) {
    // Initialize connection, possibly in root async context.
    this.socket = connect(port, host);
  }

  async query(search) {
    const task = new QueryTask(search)
    return new Promise((resolve, reject) => {
      this.socket.send(query, (result) => {
        // This async context is triggered by `DatabaseConnection` which is
        // not linked to initiator of `DatabaseConnection.query`.
        task.runInAsyncScope(() => {
          // This async context linked to the initiator of
          // `DatabaseConnection.query`.
          // PromiseResolution -> QueryTask -> `DatabaseConnection.query`
          resolve(result)
        });
      });
    });
  }
}

// A simple task that extends AsyncTask.
class QueryTask extends AsyncTask {
  constructor(search) {
    // link async task to current execution async context
    super();
    this.search = search;
  }
}
```

In the example above, `DatabaseConnection` can be established at root async
context (or any other context). With `AsyncTask`, each call to
`DatabaseConnection.query` will schedule an async task, which will be linked
to its initiator async context (may not be the one establishing
`DatabaseConnection`). And at the resolution of socket, the contexts are
propagated by the `DatabaseConnection`, which is linked to its initiating
async context, so the async context has to be re-established by
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
those two definitions. The major motivation of `AsyncTask` is to declare a
logical connection between multiple asynchronously executions. With these
connections, the only use case in this proposal is to propagate the values of
AsyncLocal correctly. However, many features still can be built on top of the
connections built by `AsyncTask`.

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
