# Zones for JavaScript

[Spec](https://domenic.github.io/zones)

# Status

This proposal is in stage 0 of [the TC39 process](https://tc39.github.io/process-document/), and is getting formalized and fleshed out in preparation for further advancement. It was originally [presented at the January 2016 TC39 meeting](https://github.com/tc39/tc39-notes/blob/master/es7/2016-01/2016-01-26.md#5i-zones).

# Motivation

Zones are meant to help with the problems of writing asynchronous code. They are designed as a primitive for context propagation across multiple logically-connected async operations. As a simple example, consider the following code:

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

To be clear, none of these use cases are solved out of the box by this base zones proposal. We instead provide the JavaScript-level primitive to allow host environments, frameworks, and developers to solve them.

# Proposed Solution

We represent zones with a `Zone` object, which has the following API:

```js
class Zone {
  constructor({ name });

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

## Manually using zones, for illustrative purposes only

For illustrative purposes only, let's look at how we would use these fundamental building blocks to propagate async context in our above example. As we will shortly explain, you would never actually write this code.

```js
window.onload = Zone.current.wrap(e => {
  // (1)

  fetch("https://example.com").then(Zone.current.wrap(res => {
    // (2)

    return processBody(res.body).then(Zone.current.wrap(data => {
      // (5)

      const dialog = html`<dialog>Here's some cool data: ${data}
                          <button>OK, cool</button></dialog>`;
      dialog.show();

      dialog.querySelector("button").onclick = Zone.current.wrap(() => {
        // (6)
        dialog.close();
      });
    }));
  }));
});

function processBody(body) {
  // (3)
  return body.json().then(Zone.current.wrap(obj => {
    // (4)
    return obj.data;
  }));
}
```

As you can see, there's a pretty obvious pattern: every callback which could potentially be called asynchronously, gets wrapped with `Zone.current.wrap(cb)`.

## Language integration

With this example in mind, the benefit of language integration becomes more clear:

1. We can automatically "wrap" the `onFulfilled` and `onRejected` callbacks passed to promise handlers, with a slight update to the promise parts of the spec. Thus, all asynchronous operations that are possible purely within the JavaScript spec correctly propagate zones. (This also applies to the upcoming `async`/`await` proposal; we would save/restore the current zone before/after an `await`.)
1. We provide a strong foundational hook for all asynchronous host environment APIs that do not use promises, such as the web's `EventTarget` and `MutationObserver`, or Node.js's `EventEmitter` and errback-pattern, to wrap the relevant callbacks and thus also propagate zones correctly.
1. Finally, we provide the hooks for developers to directly wrap their callbacks if necessary, using `Zone.current.wrap` and `Zone.current.run`. This will typically be used by framework developers with complex scheduling needs.
