# Async Tasks Tracking for JavaScript

Status: This proposal has not been presented to TC39 yet.

# Motivation

Provide a mechanism to ergonomically track async tasks in JavaScript. There are multiple implementations
in different platforms like `async_hooks` in Node.js and `zones.js` in Angular that provides async task
tracking. These modules works well in its very own platform, yet they are not in quite same with each other.
Library owners have to adopt both two, or more, to keep a persistent async context across async
tasks execution.

Tracked async tasks are useful for debugging, testing, and profiling. With async tasks tracked, we can
determine what tasks have been scheduled during a specific sync run, and do something additional on
schedule changes, e.g. asserting there is no outstanding async task on end of a test case. Except for
merely tasks tracking, it is also critical to have persist async locals that will be propagated along
with the async task chains, which additional datum can be stored in and fetched from without awareness
or change of the task original code, e.g. `AsyncLocalStorage` in Node.js.

While monkey-patching is quite straightforward solution to track async tasks, there is no way to patch
mechanism like async/await. Also, monkey-patching only works if all third-party libraries with custom
scheduling call a corresponding task awareness registration like `Zone.run`/`AsyncResource.runInAsyncScope`.
Furthermore, for those custom scheduling third-party libraries, we need to get library owners to think in
terms of async context propagation.

In a summary, we would like to have an async task tracking specification right in ECMAScript to be in place
for platform environments to take advantage of it, and a standard JavaScript API to enable third-party
libraries to work on different environments seamlessly.

Priorities (not necessarily in order):
1. **Must** be able to automatically link continuate async tasks.
1. **Must** expose visibility into the task scheduling and processing of host environment.
    1. **Must** not collide or introduce implicit behavior on multiple tracking instance on same async task chain.
    1. **Should** be scoped to the an async task chain.
1. **Must** provide a way to provide reentrancy with namespaced async local storage.

Non-goals:
1. Error handling & bubbling through async stacks:
2. Async task interception: this can cause confusion if some imported library can take application owner
unaware actions to change how the application code running pattern. At this very first proposal, we'd like
to stand away with this feature. If there are multiple tracking instance on same async task chain,
interception can cause collision and implicit behavior if these instances do not cooperate well.

# Strawperson usage

Zones are meant to help with the problems of tracking asynchronous code. They are designed as a primitive for
context propagation across multiple logically-connected async operations. As a simple example, consider the
following code:

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

At all six marked points, the "async context" is the same: we're in an "async stack" originating from the `load` event on `window`. Note how `(3)` and `(4)` are outside the lexical context, but is still part of the same "async stack". And note how the promise chain does not suffice to capture this notion of async stack, as shown by `(6)`.

Zones are meant specifically as a building block to reify this notion of "logical async context". The core new mechanism of this proposal is associating each async operation with a zone. On top of this, other work, perhaps outside of JavaScript proper, can build on this powerful base association. Such work can accomplish things like:

- Associating "zone-local data" with the zone, analogous to thread-local storage in other languages, which is accessible to any async operation inside the zone.
- Automatically tracking outstanding async operations within a given zone, to perform cleanup or rendering or test assertion steps afterward
- Timing the total time spent in a zone, for analytics or in-the-field profiling
- Handling all uncaught exceptions or unhandled promise rejections within a zone, instead of letting them propagate to the top level

To be clear, none of these use cases are solved out of the box by this base zones proposal. We instead provide the JavaScript-level primitive to allow host environments, frameworks, and developers to solve them. See the ["Zone Solutions"](Zone Solutions.md) document for concrete examples of how this could work.

# Proposed Solution

```js
class AsyncZone {
  constructor(asyncZoneSpec, initialStoreGetter);

  attach(): this;
  detach(): this;

  inEffectiveZone(): boolean;

  getStore(): any;
}

interface AsyncZoneSpec {
  scheduledAsyncTask(task);
  beforeAsyncTaskExecute(task);
  afterAsyncTaskExecute(task);
}
```

<!--
TODO: how do we determine a task is not going to be used anymore?

Fundamentally if an object is going to be finalized, it can not be used afterward.
If an async task says it is disposed, `runInAsyncScope` throws once disposed.
-->

For library owners, `AsyncTask`s are preferred to schedule a new async task.

```js
class AsyncTask {
  static scheduleAsyncTask(name): AsyncTask;

  get name;

  runInAsyncScope(callback[, thisArg, ...args]);
  [@@dispose]();
}
```


### Using `Zone` for async local storage

<!--
TODO: what's the recommended pattern to enter/attach a zone?

Since async local storage is namespaced in the example: we don't have a global zones effective by default.
Users of async local storage have to declare their own store with their own zones.
Async pattern does work, yet sync one can be adopt more seamlessly to existing codes.
-->

```js
const zone = Zone(
  /** initialValueGetter */() => ({ startTime: Date.now() }),
);
function trackStart() {
  // (a)
  zone.attach();
}
function trackEnd() {
  // (b)
  const dur = Date.now() - zone.getStore().startTime;
  console.log('onload duration:', dur);
  zone.detach();
}

window.onload = e => {
  // (1)
  trackStart()

  fetch("https://example.com").then(res => {
    // (2)

    return processBody(res.body).then(data => {
      // (3)

      const dialog = html`<dialog>Here's some cool data: ${data}
                          <button>OK, cool</button></dialog>`;
      dialog.show();

      trackEnd();
    });
  });
};
```

In the example above, `trackStart` and `trackEnd` don't share same lexical scope, and they are capable of
reentrance.

# Prior Arts

## Zones
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

Zones have an optional `name`, which is used for tooling and debugging purposes.

Zones can be `fork`ed, creating a _child zone_ whose `parent` pointer is the forker.

The concept of the _current zone_, reified as `Zone.current`, is crucial. Both `run` and `wrap` are designed to manage running the current zone:

- `z.run(callback)` will set the current zone to `z` for the duration of `callback`, resetting it to its previous value afterward. This is how you "enter" a zone.
- `z.wrap(callback)` produces a new function that essentially performs `z.run(callback)` (passing along arguments and this, of course).

The _current zone_ is the async context that propagates with all our operations. In our above example, sites `(1)` through `(6)` would all have the same value of `Zone.current`. If a developer had done something like:

```js
const loadZone = Zone.current.fork({ name: "loading zone" });
window.onload = loadZone.wrap(e => { ... });
```

then at all those sites, `Zone.current` would be equal to `loadZone`.

## Node.js `domain` module

## Node.js `async_hooks`

This is what the proposal evolved from. `async_hooks` in Node.js enabled async resources tracking for APM vendors. On which Node.js also implemented `AsyncLocalStorage`.
