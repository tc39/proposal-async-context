# Introduction

The purpose of this document is to explain the integration of AsyncContext with
the web platform. In particular, when a callback is run, what values do
`AsyncContext.Variable`s have? In other words, which `AsyncContext.Snapshot` is
restored?

In this document we look through various categories of web platform APIs and we
propose their specific AsyncContext behavior. We also look into how this could
be implemented, in the initial rollout and over time, as well as consider
existing or experimental web platform features that could use the AsyncContext
machinery.

Although this document focuses on the web platform, and on web APIs, it is also
expected to be relevant to other JavaScript environments and runtimes. This will
necessarily be the case for [WinterTC](https://wintertc.org)-style runtimes,
since they will implement web APIs. However, the integration with the web
platform is also expected to serve as a model for other APIs in other JavaScript
environments.

For details on the memory management aspects of this proposal, see [this
companion document](./MEMORY-MANAGEMENT.md).

## Background

The AsyncContext proposal allows associating state implicitly
with a call stack, such that it propagates across asynchronous tasks and promise
chains. In a way it is the equivalent of thread-local storage, but for async
tasks. APIs like this (such as Node.js’s `AsyncLocalStorage`, whose API
`AsyncContext` is inspired by) are fundamental for a number of diagnostics tools
such as performance tracers.

This proposal provides `AsyncContext.Variable`, a class whose instances store a
JS value. The value after creation can be set from the constructor and is
`undefined` by default. After initialization, though, the value can only be
changed through the `.run()` method, which takes a callback and synchronously
runs it with the changed value. After it returns, the previous value is
restored.

```js
const asyncVar = new AsyncContext.Variable();

console.log(asyncVar.get());  // undefined

asyncVar.run("foo", () => {
  console.log(asyncVar.get());  // "foo"
  asyncVar.run("bar", () => {
    console.log(asyncVar.get());  // "bar"
  });
  console.log(asyncVar.get());  // "foo"
});

console.log(asyncVar.get());  // undefined
```

What makes this equivalent to thread-local storage for async tasks is that the
value stored for each `AsyncContext.Variable` gets preserved across awaits, and
across any asynchronous task.

```js
const asyncVar = new AsyncContext.Variable();

asyncVar.run("foo", async () => {
  console.log(asyncVar.get());  // "foo"
  await new Promise(resolve => setTimeout(resolve, 2000));
  console.log(asyncVar.get());  // "foo"
});

asyncVar.run("bar", async () => {
  console.log(asyncVar.get());  // "bar"
  await new Promise(resolve => setTimeout(resolve, 1000));
  await asyncVar.run("baz", async () => {
    console.log(asyncVar.get());  // "baz"
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log(asyncVar.get());  // "baz"
  });
  console.log(asyncVar.get());  // "bar"
});
```

Note that the above sample can’t be implemented by changing some private state
of the `asyncVar` object without awareness of `async`/`await`, because the
promise in foo resolves in the middle of the baz run.

If you have multiple `AsyncContext.Variable` instances active when an `await`
happens, all of their values must be stored before the `await`, and then
restored when the promise resolves. The same goes for any other kind of async
continuation. An alternative way to see this is having a single global
(per-agent) variable storing a map whose keys are `AsyncContext.Variable`
instances, which would be replaced by a modified copy at the start of every
`.run()` call. Before the `await`, a reference would be taken to the current
map, and after the promise resolves, the current map would be set to the stored
reference.

Being able to store this map and restore it at some point would also be useful
in userland to build custom userland schedulers, and `AsyncContext.Snapshot`
provides this capability. An `AsyncContext.Snapshot` instance represents a value
of the map, where constructing an instance takes a reference to the current map,
and calling `.run()` with a callback lets you restore it. Notably, this API does
not allow iterating through the map or observing its contents directly – you can
only observe the value associated with an `AsyncContext.Variable` instance if
you have access to that instance.

```js
const deferredFunctions = [];

// `deferFunction` is a userland scheduler
export function deferFunction(cb) {
  const snapshot = new AsyncContext.Snapshot();
  deferredFunctions.push({cb, snapshot});
}

export function callDeferredFunctions() {
  for (const {cb, snapshot} of deferredFunctions) {
    snapshot.run(cb);
  }
  deferredFunctions = [];
}
```

Capturing and restoring `AsyncContext.Snapshot` instances is a very common
operation, due to its implicit usage in every `await`. For this reason, it is
expected to be implemented as a simple pointer copy. See the
[V8 AsyncContext Design Doc](https://docs.google.com/document/d/19gkKY6qC3L5X8WtSAmFq33iNnzeer1mL5495oT1owjY/edit#heading=h.mwad14vicl1e)
for a concrete implementation design.

Web frameworks such as React may decide to save and restore
`AsyncContext.Snapshot`s when re-rendering subtrees. More outreach to frameworks
is needed to confirm exactly how this will be used.


## General approach to web API semantics with AsyncContext

The AsyncContext API isn’t designed to be used directly by most
JavaScript application developers, but rather as an implementation detail of certain
third-party libraries. AsyncContext makes it so users of those libraries don’t
need to explicitly integrate with it. Instead, the AsyncContext mechanism
handles implicitly passing contextual data around.

In general, contexts should propagate along an algorithm’s data flow. If an
algorithm running in the event loop synchronously calls another algorithm or
performs a script execution, that algorithm and script would have the same
context as the caller’s. This is handled automatically. However, when the data
flow is asynchronous –such as queuing a task or microtask, running some code in
parallel, or storing an algorithm somewhere to invoke it later–, the propagation
must be handled by some additional logic.

To propagate this context without requiring further JavaScript developer
intervention, web platform APIs which will later run JavaScript callbacks should
propagate the context from the point where the API was invoked to where the
callback is run (i.e. save the current `AsyncContext.Snapshot` and restore it
later). Without built-in web platform integration, web developers may need to
“monkey-patch” many web APIs in order to save and restore snapshots, a technique
which adds startup cost and scales poorly as new web APIs are added.

In some cases there is more than one incoming data flow, and therefore multiple
possible `AsyncContext.Snapshot`s that could be restored. To discuss them, we
group them into two categories:

- A **registration context** is the context in which that callback is passed
  into a web API so it can be run. For events, this would be the context in
  which `addEventListener` is called or an event handler attribute
  (e.g. `onclick`) is set.
  
- The **causal context** (also called the dispatch context, especially in
  reference to events) is the context in which some web API is called that
  ultimately causes the callback to be called. This is usually an API that
  starts an async operation which ultimately calls the callback
  (e.g. `xhr.send()`, which causes the XHR events to be fired), but it can also
  be an API that calls the callback synchronously (e.g. `htmlEl.click()`, which
  synchronously fires a `click` event). If the callback is not caused by any
  userland JS code in the same agent (e.g. a user-originated `click` event),
  there is no causal context.

We propose that, in general, if there is a causal context, that should be the
context that the callback should be called with; otherwise, the registration
context should be used. However, if an API is used in multiple different ways
(e.g. events), it should stay consistent in all uses of that API. Therefore,
there are cases where the causal context should be used even though it does not
exist. In such cases, the **empty context** (where every `AsyncContext.Variable`
is set to its default value) is used instead.

In the rest of this document, we look at various kinds of web platform APIs
which accept callbacks or otherwise need integration with AsyncContext, and
examine which context should be used.


# Individual analysis of web APIs and AsyncContext

## Web APIs that take callbacks

For web APIs that take callbacks, the context in which the callback is run would
depend on the kind of API:

### Schedulers

These are web APIs whose sole purpose is to take a callback and schedule it in
the event loop in some way. The callback will run asynchronously at some point,
when there is no other JS code in the call stack.

For these APIs, the causal context is the same as the registration context – the
context in which the API is called. After all, that API call starts a background
user-agent-internal operation that results in the callback being called.
Therefore, this is the context the callback should be called with.

Examples of scheduler web APIs:
- [`setTimeout()`](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#dom-settimeout)
  [\[HTML\]](https://html.spec.whatwg.org/multipage/)
- [`setInterval()`](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#dom-setinterval)
  [\[HTML\]](https://html.spec.whatwg.org/multipage/)
- [`queueMicrotask()`](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#dom-queuemicrotask)
  [\[HTML\]](https://html.spec.whatwg.org/multipage/)
- [`requestAnimationFrame()`](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#dom-animationframeprovider-requestanimationframe)
  [\[HTML\]](https://html.spec.whatwg.org/multipage/)
- [`requestIdleCallback()`](https://w3c.github.io/requestidlecallback/#dom-window-requestidlecallback)
  [\[REQUESTIDLECALLBACK\]](https://w3c.github.io/requestidlecallback/)
- [`scheduler.postTask()`](https://wicg.github.io/scheduling-apis/#dom-scheduler-posttask)
  [\[SCHEDULING-APIS\]](https://wicg.github.io/scheduling-apis/)
- [`HTMLVideoElement`](https://html.spec.whatwg.org/multipage/media.html#htmlvideoelement):
  [`requestVideoFrameCallback()`](https://wicg.github.io/video-rvfc/#dom-htmlvideoelement-requestvideoframecallback)
  method [\[VIDEO-RVFC\]](https://wicg.github.io/video-rvfc/)

### Async completion callbacks

These web APIs start an asynchronous operation, and take callbacks to indicate
that the operation has completed. These are usually legacy APIs, since modern
APIs would return a promise instead.

For these APIs, since the async operation starts when the web API is called, the
dispatch context is the same as the registration context. Therefore, this
context (the one in which the API is called) should be used for the callback.
This would also make these callbacks behave the same as they would when passed
to the `.then()` method of a promise.

- [`HTMLCanvasElement`](https://html.spec.whatwg.org/multipage/canvas.html#htmlcanvaselement):
  [`toBlob()`](https://html.spec.whatwg.org/multipage/canvas.html#dom-canvas-toblob)
  method [\[HTML\]](https://html.spec.whatwg.org/multipage/)
- [`DataTransferItem`](https://html.spec.whatwg.org/multipage/dnd.html#datatransferitem):
  [`getAsString()`](https://html.spec.whatwg.org/multipage/dnd.html#dom-datatransferitem-getasstring)
  method [\[HTML\]](https://html.spec.whatwg.org/multipage/)
- [`Notification.requestPermission()`](https://notifications.spec.whatwg.org/#dom-notification-requestpermission)
  [\[NOTIFICATIONS\]](https://notifications.spec.whatwg.org/)
- [`BaseAudioContext`](https://webaudio.github.io/web-audio-api/#BaseAudioContext):
  [`decodeAudioData()`](https://webaudio.github.io/web-audio-api/#dom-baseaudiocontext-decodeaudiodata)
  method [\[WEBAUDIO\]](https://webaudio.github.io/web-audio-api/)
- [`navigator.geolocation.getCurrentPosition()`](https://w3c.github.io/geolocation/#dom-geolocation-getcurrentposition)
  method [\[GEOLOCATION\]](https://w3c.github.io/geolocation/)
- A number of async methods in
  [\[ENTRIES-API\]](https://wicg.github.io/entries-api/)

Some of these APIs started out as legacy APIs that took completion callbacks,
and then they were changed to return a promise – e.g. `BaseAudioContext`’s
`decodeAudioData()` method. For those APIs, the callback’s context would behave
similarly to other async completion callbacks, and the promise rejection context
would behave similarly to other promise-returning web APIs (see below).
Similarly, the WebIDL-based callback wrapping is sufficient, and there are no
meaningful alternatives to consider.

### Callbacks run as part of an async algorithm

These APIs always invoke the callback to run user code as part of an
asynchronous operation that they start, and which affects the behavior of the
operation. Since the background async operation is started by the API that takes
the callback, the registration and causal contexts are the same.

This context also matches the way these APIs could be implemented in JS:
```js
async function api(callback) {
  await doSomething();
  await callback();
  await doSomethingElse();
}
```

- [`Document`](https://dom.spec.whatwg.org/#document):
  [`startViewTransition()`](https://drafts.csswg.org/css-view-transitions-2/#dom-document-startviewtransition)
  method [\[CSS-VIEW-TRANSITIONS-1\]](https://drafts.csswg.org/css-view-transitions-1/)
- [`LockManager`](https://w3c.github.io/web-locks/#lockmanager):
  [`request()`](https://w3c.github.io/web-locks/#dom-lockmanager-request) method
  [\[WEB-LOCKS\]](https://w3c.github.io/web-locks/)

### Action registrations

These APIs register a callback or constructor to be invoked when some action
runs. They’re also commonly used as a way to associate a newly created class
instance with some action, such as in worklets or with custom elements.

In cases where the action originates due to something happening outside of the web page (such as some user action), there is no dispatch context. Therefore, the only available context is the
registration context, the one active when the web API is called.

- [`navigator.mediaSession.setActionHandler()`](https://w3c.github.io/mediasession/#dom-mediasession-setactionhandler)
  method [\[MEDIASESSION\]](https://w3c.github.io/mediasession/)
- [`navigator.geolocation.watchPosition()`](https://w3c.github.io/geolocation/#dom-geolocation-watchposition)
  method [\[GEOLOCATION\]](https://w3c.github.io/geolocation/)
- [`RemotePlayback`](https://w3c.github.io/remote-playback/#dom-remoteplayback):
  [`watchAvailability()`](https://w3c.github.io/remote-playback/#dom-remoteplayback-watchavailability)
  method [\[REMOTE-PLAYBACK\]](https://w3c.github.io/remote-playback/)

This is also the case for worklets, where the registering API (e.g.
[`registerProcessor()`](https://webaudio.github.io/web-audio-api/#dom-audioworkletglobalscope-registerprocessor)
for audio worklets [\[WEBAUDIO\]](https://webaudio.github.io/web-audio-api/), or
[`registerPaint()`](https://drafts.css-houdini.org/css-paint-api-1/#dom-paintworkletglobalscope-registerpaint)
for paint worklets [\[CSS-PAINT-API\]](https://drafts.css-houdini.org/css-paint-api-1/))
is the registration context, and the causal context is either empty or
unobservable (since `AsyncContext.Variable`s from outside the worklet cannot
cross its boundary, even if they happen to live in the same agent/thread).
Therefore, the registration context should be used.

For action registrations where the action often originates from userland JS
code, the causal context should be used instead. The main case for this is
custom elements, where the lifecycle callbacks are almost always triggered
synchronously by a call from userland JS to an API annotated with
[`[CEReactions]`](https://html.spec.whatwg.org/multipage/custom-elements.html#cereactions).
However, there are cases where this is not the case:

- If a custom element is contained inside a `<div contenteditable>`, the user
  could remove the element from the tree as part of editing, which would queue a
  microtask to call its `disconnectedCallback` hook. In this case, there would
  be no causal context, and each `AsyncContext.Variable` would be set to its
  initial value.
- A user clicking a form reset when a form-associated custom element is in the
  form would queue a microtask to call its `formResetCallback` lifecycle hook,
  and there would not be a casual context. However, if the `click()` method is
  called from JS instead, since that method doesn't have the `[CEReactions]`
  annotation, it would also call that lifecycle hook in a microtask, rather than
  synchronously. In that case, the causal context would be the one active when
  `.click()` was called.

In the cases where the registration web API takes a constructor (such as
worklets) and the registration context should be used, any getters or methods of
the constructed object that are called as a result of the registered action
should also be called with that same registration context.

### Stream underlying APIs

The underlying [source](https://streams.spec.whatwg.org/#underlying-source-api),
[sink](https://streams.spec.whatwg.org/#underlying-sink-api) and
[transform](https://streams.spec.whatwg.org/#transformer-api) APIs for streams
are callbacks/methods passed during stream construction. The context in which
the stream is constructed is then the registration context.

That registration context is also the causal context for the `start` method, but
for other methods there would be a different causal context, depending on what
causes the call to that method. For example:

- If `ReadableStreamDefaultReader`’s `read()` method is called and that causes a
  call to the `pull` method, then that would be its causal context. This would
  be the case even if the queue is not empty and the call to `pull` is deferred
  until previous invocations resolve.
- If a `Request` is constructed from a `ReadableStream` body, and that is passed
  to `fetch`, the causal context for the `pull` method invocations should be the
  context active at the time that `fetch` was called. Similarly, if a response
  body `ReadableStream` obtained from `fetch` is piped to a `WritableStream`,
  its `write` method’s causal context is the call to `fetch`.

In general, the context that should be used is the one that matches the data
flow through the algorithms ([see the section on implicit propagation
below](#implicit-context-propagation)).

> TODO: Piping is largely implementation-defined. We should figure out some
> context propagation constraints.

> TODO: If a stream gets transferred to a different agent, any cross-agent
> interactions will have to use the empty context. What if you round-trip a
> stream through another agent?

### Observers

Observers are a kind of web API pattern where the constructor for a class takes
a callback, the instance’s `observe()` method is called to register things that
should be observed, and then the callback is called when those observations have
been made.

Unlike FinalizationRegistry, which works similarly, observer callbacks are not
called once per observation. Instead, multiple observations can be batched into
one single call. This means that there is not always a single causal context
that can be used; rather, there might be many.

Given this, for consistency it would be preferable to instead use the
registration context; that is, the context in which the class is constructed.

- [`MutationObserver`](https://dom.spec.whatwg.org/#mutationobserver)
  [\[DOM\]](https://dom.spec.whatwg.org/)
- [`ResizeObserver`](https://drafts.csswg.org/resize-observer-1/#resizeobserver)
  [\[RESIZE-OBSERVER\]](https://wicg.github.io/ResizeObserver/)
- [`IntersectionObserver`](https://w3c.github.io/IntersectionObserver/#intersectionobserver)
  [\[INTERSECTION-OBSERVER\]](https://w3c.github.io/IntersectionObserver/)
- [`PerformanceObserver`](https://w3c.github.io/performance-timeline/#dom-performanceobserver)
  [\[PERFORMANCE-TIMELINE\]](https://w3c.github.io/performance-timeline/)
- [`ReportingObserver`](https://w3c.github.io/reporting/#reportingobserver)
  [\[REPORTING\]](https://w3c.github.io/reporting/)

> TODO: Due to concerns about observers leading to memory leaks, an alternative
> option is to not use the registration context, and instead call the observer's
> callback with the empty context. This is still under discussion. 

In some cases it might be useful to expose the causal context for individual
observations, by exposing an `AsyncContext.Snapshot` property on the observation
record. This should be the case for `PerformanceObserver`, where
`PerformanceEntry` would expose the snapshot as a `resourceContext` property.

## Events

Events are a single API that is used for a great number of things, including
cases which have a causal context (for events, also referred to as the
**dispatch context**) separate from the registration context, and cases which
have no dispatch context at all.

For consistency, event listener callbacks should be called with the dispatch
context. If that does not exist, the empty context should be used, where all
`AsyncContext.Variable`s are set to their initial values.

Event dispatches can be one of the following:
- **Synchronous dispatches**, where the event dispatch happens synchronously
  when a web API is called. Examples are `el.click()` which synchronously fires
  a `click` event, setting `location.hash` which synchronously fires a
  `popstate` event, or calling an `EventTarget`'s `dispatchEvent()` method. For
  these dispatches, the TC39 proposal's machinery is enough to track the
  dispatch context, with no help from web specs or browser engines.
- **Browser-originated dispatches**, where the event is triggered by browser or
  user actions, or by cross-agent JS, with no involvement from JS code in the
  same agent. Such dispatches can't have any dispatch context, so the listener
  is called with the empty context. (Though see the section on fallback context
  below.)
- **Asynchronous dispatches**, where the event originates from JS calling into
  some web API, but the dispatch happens at a later point. In these cases, the
  context should be tracked along the data flow of the operation, even across
  code running in parallel (but not through tasks enqueued on other agents'
  event loops).

For events triggered by JavaScript code (either synchronously or asynchronously),
the goal is for them to behave equivalently as if they were implemented by a
JavaScript developer that is not explicitly thinking about AsyncContext propagation:
listeners for events dispatched either **synchronously** or **asynchronously** from
JS or from a web API would use the context that API is called with.

<details>
<summary>Expand this section for examples of the equivalece with JS-authored code</summary>

Let's consider a simple approximation of the `EventTarget` interface, authored in JavaScript:
```javascript
class EventTarget {
  #listeners = [];

  addEventListener(type, listener) {
    this.#listeners.push({ type, listener });
  }

  dispatchEvent(event) {
    for (const { type, listener } of this.#listeners) {
      if (type === event.type) {
        listener.call(this, event);
      }
    }
  }
}
```

An example _synchronous_ event is `AbortSignal`'s `abort` event. A naive approximation
in JavaScript would look like the following:

```javascript
class AbortController {
  constructor() {
    this.signal = new AbortSignal();
  }

  abort() {
    this.signal.aborted = true;
    this.signal.dispatchEvent(new Event("abort"));
  }
}
```

When calling `abortController.abort()`, there is a current async context active in the agent. All operations that lead to the `abort` event being dispatched are synchronous and do not manually change the current async context: the active async context will remain the same through the whole `.abort()` process,
including in the event listener callbacks:

```javascript
const abortController = new AbortController();
const asyncVar = new AsyncContext.Variable();
abortController.signal.addEventListener("abort", () => {
  console.log(asyncVar.get()); // "foo"
});
asyncVar.run("foo", () => {
  abortController.abort();
});
```

Let's consider now a more complex case: the asynchronous `"load"` event of `XMLHttpRequest`. Let's try
to implement `XMLHttpRequest` in JavaScript, on top of fetch:

```javascript
class XMLHttpRequest extends EventTarget {
  #method;
  #url;
  open(method, url) {
    this.#method = method;
    this.#url = url;
  }
  send() {
    (async () => {
      try {
        const response = await fetch(this.#url, { method: this.#method });
        const reader = response.body.getReader();
        let done;
        while (!done) {
          const { done: d, value } = await reader.read();
          done = d;
          this.dispatchEvent(new ProgressEvent("progress", { /* ... */ }));
        }
        this.dispatchEvent(new Event("load"));
      } catch (e) {
        this.dispatchEvent(new Event("error"));
      }
    })();
  }
}
```

And lets trace how the context propagates from `.send()` in the following case:
```javascript
const asyncVar = new AsyncContext.Variable();
const xhr = new XMLHttpRequest();
xhr.open("GET", "https://example.com");
xhr.addEventListener("load", () => {
  console.log(asyncVar.get()); // "foo"
});
asyncVar.run("foo", () => {
  xhr.send();
});
```
- when `.send()` is called, the value of `asyncVar` is `"foo"`.
- it is synchronously propagated up to the `fetch()` call in `.send()`
- the `await` snapshots the context before pausing, and restores it (to `asyncVar: "foo"`) when the `fetch` completes
- the `await`s in the reader loop propagate the context as well
- when `this.dispatchEvent(new Event("load"))`, is called, the current active async context is thus
  the same one as when `.send()` was called
- the `"load"` callback thus runs with `asyncVar` set to `"foo"`.

Note that this example uses `await`, but due to the proposed semantics for `.then` and `setTimeout`
(and similar APIs), the same would happen when using other asynchronicity primitives. Note that most APIs
dealing with I/O are not actually polyfillable in JavaScript, but you can still emulate/mock them with
testing data.

</details>

Event listeners for events dispatched **from the browser** rather than as a consequence of some JS action (e.g. a user clicking on a button) will by default run in the root (empty) context. This is the same
context that the browser uses, for example, for the top-level execution of scripts.

> NOTE: To keep agents isolated, events dispatched from different agents (e.g. from a worker, or from a cross-origin iframe) will behave like events dispatched by user interaction. This also applies to events dispatched from cross-origin iframes in the same agent, to avoid exposing the fact that they're in the same agent.

### Fallback context ([#107](https://github.com/tc39/proposal-async-context/issues/107))

This use of the empty context for browser-originated dispatches, however,
clashes with the goal of allowing “isolated” regions of code that share an event
loop, and being able to trace in which region an error originates. A solution to
this would be the ability to define fallback values for some `AsyncContext.Variable`s
when the browser runs some JavaScript code due to a browser-originated dispatch.

```javascript
const widgetID = new AsyncContext.Variable();

widgetID.run("weather-widget", () => {
  captureFallbackContext(widgetID, () => {
    renderWeatherWidget();
  });
});
```

In this example, event listeners registered by `renderWeatherWidget` would be guaranteed
to always run as a consequence of some "widget": if the event is user-dispatched, then
it defaults to `weather-widget` rather than to `widgetID`'s default value (`undefined`,
in this case). There isn't a single global valid default value, because a page might have
multiple widgets that thus need different fallbacks.

<details>
<summary>Expand this section to read the full example</summary>

This complete example shows that when clicking on a button (thus, without a JavaScript cause
that could propagate the context), some asynchronus operations start. These operations
might reject, firing a `unhandledrejection` event on the global object.

If there was no fallback context, the `"click"` event would run with `widgetID` unset, that
would thus be propagated unset to `unhandledrejection` as well. Thanks to `captureFallbackContext`,
the user-dispatched `"click"` event will fallback to running with `widgetID` set to
`"weather-widget"`, which will then be propagated to `unhandledrejection`.

```javascript
const widgetID = new AsyncContext.Variable();

widgetID.run("weather-widget", () => {
  captureFallbackContext(widgetID, () => {
    renderWeatherWidget();
  });
});

addEventListener("unhandledrejection", event => {
  console.error(`Unhandled rejection in widget "${widgetID.get()}"`);
  // Handle the rejection. For example, disable the widget, or report
  // the error to a server that can then notify the widget's developers.
});
```

```javascript
function renderWeatherWidget() {
  let day = Temporal.Now.plainDate();

  const widget = document.createElement("div");
  widget.innerHTML = `
    <button id="prev">Previous day</button>
    <output>...</output>
    <button id="next">Next day</button>
  `;
  document.body.appendChild(widget);

  const load = async () => {
    const response = await fetch(`/weather/${day}`);
    widget.querySelector("output").textContent = await response.text();
  };

  widget.querySelector("#prev").addEventListener("click", async () => {
    day = day.subtract({ days: 1 });
    await load();
  });
  widget.querySelector("#next").addEventListener("click", async () => {
    day = day.add({ days: 1 });
    await load();
  });

  load();
}
```

When the user clicks on one of the buttons and the `fetch` it triggers fails,
without using `captureFallbackContext` the `unhandledrejection` event listener
would not know that the failure is coming from the `weather-widget` widget.

Thanks to `captureFallbackContext`, that information is properly propagated.

</details>

This fallback is per-variable and not based on `AsyncContext.Snapshot`, to avoid
accidentally keeping alive unnecessary objects.

There are still some questions about `captureFallbackContext` that need to be
answered:
- should it take just one variable or a list of variables?
- should it just be for event targets, or for all web APIs that take a callback
  which can run when triggered from outside of JavaScript? (e.g. observers)
- should it be a global, or a static method of `EventTarget`?

## Script errors and unhandled rejections

The `error` event on a window or worker global object is fired whenever a script
execution throws an uncaught exception. The context in which this exception was
thrown is the causal context. Likewise, the `unhandledrejection` is fired
whenever a promise resolves without a rejection, without a registered rejection
handler, and the causal context is the one in which the promise was rejected.

Having access to the contexts which produced these errors is useful to determine
which of multiple independent streams of async execution caused this error, and
therefore how to clean up after it. For example:

```js
async function doOperation(i: number, signal: AbortSignal) {
  // ...
}

const operationNum = new AsyncContext.Variable();
const controllers: AbortController[] = [];

for (let i = 0; i < 20; i++) {
  controllers[i] = new AbortController();
  operationNum.run(i, () => doOperation(i, controllers[i].signal));
}

window.onerror = window.onunhandledrejection = () => {
  const idx = operationNum.get();
  controllers[idx].abort();
};
```

### Unhandled rejection details

The `unhandledrejection` causal context could be unexpected in some cases. For
example, in the following code sample, developers might expect `asyncVar` to map
to `"bar"` in that context, since the throw that causes the promise rejection
takes place inside `a()`. However, the promise that rejects *without having a
registered rejection handled* is the promise returned by `b()`, which only
outside of the `asyncVar.run("bar", ...)` returns. Therefore, `asyncVar` would
map to `"foo"`.


```js
async function a() {
  console.log(asyncVar.get());  // "bar"
  throw new Error();
}

async function b() {
  console.log(asyncVar.get());  // "foo"
  await asyncVar.run("bar", async () => {
    const p1 = a();
    await p1;
  });
}

asyncVar.run("foo", () => {
  const p2 = b();
});
```

If a promise created by a web API rejects, the `unhandledrejection` event’s
dispatch context would be track as usual for causal contexts. According to the
categories in the [“Writing Promise-Using Specifications”](https://w3ctag.github.io/promises-guide/) guide:
- For one-and-done operations, the rejection-time context of the returned
  promise should be the context when the web API that returns it was called.
- For one-time “events”, the rejection context would be the context in which the
  promise is caused to reject. In many cases, the promise is created at the same
  time as an async operation is started which will eventually resolve it, and so
  the context would flow from creation to rejection (e.g. for the
  [`loaded`](https://drafts.csswg.org/css-font-loading-3/#dom-fontface-loaded)
  property of a [`FontFace`](https://drafts.csswg.org/css-font-loading-3/#fontface)
  instance, creating the `FontFace` instance causes both the promise creation
  and the loading of the font). But this is not always the case, as for the
  [`ready`](https://streams.spec.whatwg.org/#default-writer-ready) property of a
  [`WritableStreamDefaultWriter`](https://streams.spec.whatwg.org/#writablestreamdefaultwriter),
  which could be caused to reject by a different context. In such cases, the
  context should be [propagated implicitly](#implicit-context-propagation).
- More general state transitions are similar to one-time “events” which can be
  reset, and so they should behave in the same way.

## Cross-document navigations

When a cross-document navigation happens, even if it is same-origin, the context
will be reset such that document load and tasks that directly flow from it
(including execution of classic scripts found during parsing) run with the
empty AsyncContext snapshot, which will be an empty mapping (i.e. every
`AsyncContext.Variable` will be set to its initial value).

## Module evaluation

When you import a JS module multiple times, it will only be fetched and
evaluated once. Since module evaluation should not be racy (i.e. it should not
depend on the order of various imports), the context should be reset so that
module evaluation always runs with the empty AsyncContext snapshot.

# Editorial aspects of AsyncContext integration in web specifications

An agent always has an associated AsyncContext mapping, in its
`[[AsyncContextMapping]]` field[^1]. When the agent is created, this mapping will be
set to an HTML-provided initial state, but JS user code can change it in a
strictly scoped way.

[^1]: The reason this field is agent-wide rather than per-realm is so calling a
function from a different realm which calls back into you doesn’t lose the
context, even if the functions are async.

In the current proposal, the only way JS code can modify the current mapping is
through `AsyncContext.Variable` and `AsyncContext.Snapshot`’s `run()` methods,
which switch the context before calling a callback and switch it back after it
synchronously returns or throws. This ensures that for purely synchronous
execution, the context is automatically propagated along the data flow. It is
when tasks and microtasks are queued that the data flow must be tracked through
web specs.

The TC39 proposal spec text includes two abstract operations that web specs can
use to store and switch the context:
- [`AsyncContextSnapshot()`](https://tc39.es/proposal-async-context/#sec-asynccontextsnapshot)
  returns the current AsyncContext mapping.
- [`AsyncContextSwap(context)`](https://tc39.es/proposal-async-context/#sec-asynccontextswap)
  sets the current AsyncContext mapping to `context`, and returns the previous
  one. `context` must only be a value returned by one of these two operations.

We propose adding a web spec algorithm “run the AsyncContext Snapshot”, that could be used like this:

> 1. Let _context_ be
>    [AsyncContextSnapshot](https://tc39.es/proposal-async-context/#sec-asynccontextsnapshot)().
> 1. [Queue a global task](https://html.spec.whatwg.org/multipage/webappapis.html#queue-a-global-task)
>    to run the following steps:
>    1. Run the AsyncContext Snapshot context while performing the following
>       steps:
>       1. Perform some algorithm, which might call into JS.

This algorithm, when called with an AsyncContext mapping _context_ and a set of
steps _steps_, would do the following:

> 1. Let _previousContext_ be
>    [AsyncContextSwap](https://tc39.es/proposal-async-context/#sec-asynccontextswap)(_context_).
> 1. Run _steps_. If this throws an exception _e_, then:
>    1. [AsyncContextSwap](https://tc39.es/proposal-async-context/#sec-asynccontextswap)(_previousContext_).
>    1. Throw _e_.
> 1. [AsyncContextSwap](https://tc39.es/proposal-async-context/#sec-asynccontextswap)(_previousContext_).

For web APIs that use the registration context and take a callback, this should
be handled in WebIDL by storing the result of `AsyncContextSnapshot()` alongside
the callback function, and swapping it when the function is called. Since this
should not happen for every callback, there should be a WebIDL extended
attribute applied to callback types to control this.

## Implicit context propagation

> TODO: This section of the web integration proposal is not as baked as most of
> the rest. Depending on which / how many asynchronous events we end up
> propagating, we might not need to add this into the spec, and we could replace
> it with manual context propagation at a number of places.

While tracking contexts along algorithm data flows is straightforward when it
happens synchronously within a single event loop task, in some cases (such as
for asynchronously dispatched events, or unhandled promise rejections) the
context should be tracked through parallel algorithms and through tasks being
queued into the event loop.

In a number of these cases, in particular for asynchronously dispatched events,
there is no need for the browser engine to track the data flow, because the
result is trivial (e.g. XHR events will have the context of the `xhr.send()`
call that caused them). But in other cases it's not that simple.

We propose that the HTML event loop’s queueing algorithms, such as
[queue a task](https://html.spec.whatwg.org/multipage/webappapis.html#queue-a-task),
[queue a microtask](https://html.spec.whatwg.org/multipage/webappapis.html#queue-a-microtask),
as well as [in parallel](https://html.spec.whatwg.org/multipage/infrastructure.html#in-parallel),
should propagate the current AsyncContext mapping, even through parallel
algorithms, so that every event loop task has the right causal context by
default.

The details of this implementation are still left to figure out, but each set of
steps running in parallel would have a current snapshot (sort of a thread-local
variable), which would be a parallel equivalent of an event loop's
`[[AsyncContextMapping]]` agent field. And whenever the spec says to run a set
of steps in parallel, or to queue a task/microtask, the current snapshot or
`[[AsyncContextMapping]]` would be propagated to that parallel algorithm or
task. Browser-originated tasks or parallel algorithms would have an empty
current snapshot.

In some cases, this automatic context propagation might not do the right thing,
however, particularly in cases where the exact data flow of certain steps is
handwaved (e.g. fetch’s interaction with the HTTP spec, or CSSOM View events).
In those cases, the context would have to manually tracked in the specs as shown
in the previous section.

Now, it might be that the exact data flow of the browser implementation of some
algorithms might not exactly match the spec’s data flow in all cases. This is
especially the case in browsers that have a renderer process vs main process
architecture. And in general, this implicit propagation might be hard to
implement and get right in browser engines.

Most web APIs, in fact, although could be implemented through implicit context
propagation, can also be implemented by storing the causal context and restoring
it when the callback gets called. This is not generally the case for events with
asynchronous dispatches, but it is for some. Therefore, in order to avoid
needing browser engines to implement the whole implicit context propagation
machinery in the initial AsyncContext rollout, we propose limiting the set of
event dispatches that behave as if they were asynchronous dispatches, as
outlined above.

## Exposing snapshots to JS code

Anytime that a web spec needs to expose a context other than the current one
when some code is run, such as the causal context for observer entries, it
should be exposed as an `AsyncContext.Snapshot` object. The AsyncContext
proposal has the
[`CreateAsyncContextSnapshot()`](https://tc39.es/proposal-async-context/#sec-createasynccontextsnapshot)
abstract operation for this, which takes a mapping and returns an
`AsyncContext.Snapshot` instance.

For snapshots exposed as properties of observer entries or other web platform
objects, `CreateAsyncContextSnapshot()` should be called in the relevant realm
of that web platform object. If an `AsyncContext.Snapshot` object must created
in any other case (e.g. to pass as an argument into a callback), this operation
should be called in the relevant realm of `this` (see
https://github.com/whatwg/webidl/issues/135). It might therefore make sense to
instead define an equivalent of that abstract operation in WebIDL, that handles
this.

Note that for properties of observer entries, implementations may allocate the
actual `AsyncContext.Snapshot` instance lazily on first access, if they just
store the internal pointer to the underlying snapshot when the event is created.

## Using AsyncContext from web specs

There are use cases in the web platform that would benefit from using
AsyncContext variables built into the platform, since there are often relevant
pieces of contextual information which would be impractical to pass explicitly
as parameters. Some of these use cases are:

- **Task attribution**. The soft navigations API
  [\[SOFT-NAVIGATIONS\]](https://wicg.github.io/soft-navigations/) needs to be
  able to track which tasks in the event loop are caused by other tasks, in
  order to measure the time between the user interaction that caused the soft
  navigation, and the end of the navigation. Currently this is handled by
  modifying a number of event loop-related algorithms from the HTML spec, but
  basing it on AsyncContext might be easier. It seems like this would also be
  useful [to identify scripts that enqueued long
  tasks](https://github.com/w3c/longtasks/issues/89), or to [build dependency
  trees for the loading of
  resources](https://github.com/w3c/resource-timing/issues/263). See
  https://github.com/WICG/soft-navigations/issues/44.

- **`scheduler.yield` priority and signal**. In order to provide a more
  ergonomic API, if
  [`scheduler.yield()`](https://wicg.github.io/scheduling-apis/#dom-scheduler-yield)
  is called inside a task enqueued by
  [`scheduler.postTask()`](https://wicg.github.io/scheduling-apis/#dom-scheduler-posttask)
  [\[SCHEDULING-APIS\]](https://wicg.github.io/scheduling-apis/), its `priority`
  and `signal` arguments will be “inherited” from the call to `postTask`. This
  inheritance should propagate across awaits. See
  https://github.com/WICG/scheduling-apis/issues/94.

- **Future possibility: ambient `AbortSignal`**. This would allow using an
  `AbortSignal` without needing to pass it down across the call stack until the
  leaf async operations. See
  https://gist.github.com/littledan/47b4fe9cf9196abdcd53abee940e92df

- **Possible refactoring: backup incumbent realm**. The HTML spec infrastructure
  for the [incumbent realm](https://html.spec.whatwg.org/multipage/webappapis.html#concept-incumbent-everything)
  uses a stack of backup incumbent realms synchronized with the JS execution
  stack, and explicitly propagates the incumbent realm through `await`s using JS
  host hooks. This might be refactored to build on top of AsyncContext, which
  might help fix some long-standing disagreements between certain browsers and
  the spec.

For each of these use cases, there would need to be an `AsyncContext.Variable`
instance backing it, which should not be exposed to JS code. We expect that
algorithms will be added to the TC39 proposed spec text, so that web specs don’t
need to create JS objects.