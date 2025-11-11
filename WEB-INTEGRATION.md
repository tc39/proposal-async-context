# Introduction

The purpose of this document is to explain the integration of AsyncContext with
the web platform. In particular, when a callback is run, what values do
`AsyncContext.Variable`s have? In other words, which `AsyncContext.Snapshot` is
restored?

This document focuses on the web platform, and on web APIs, it is also
expected to be relevant to other JavaScript environments and runtimes. This will
necessarily be the case for [WinterTC](https://wintertc.org)-style runtimes,
since they will implement web APIs.

For details on the memory management aspects of this proposal, see [this
companion document](./MEMORY-MANAGEMENT.md).

## Background

The [AsyncContext proposal](./README.md) introduces the APIs to preserve context
values across promise handlers, and `async`/`await` boundaries. However, to make
the proposal successful, the web platform should also integrate with the async
context propagation at the boundaries of async tasks, so that
`AsyncContext.Variable`s can be used to track context across all asynchronous
operations on a web page.

The AsyncContext API is primarily designed to be used by certain libraries
to provide good DX to web developers. AsyncContext makes it so users
of those libraries don't need to explicitly passing context around. Instead, the
AsyncContext mechanism handles implicitly passing contextual data around.

To propagate this context without requiring further JavaScript developer
intervention, web platform APIs which will later run JavaScript callbacks should
propagate the context from the point where the API was invoked to where the
callback is run (i.e. save the current `AsyncContext.Snapshot` and restore it
later).

Without built-in web platform integration, web developers may need to
"monkey-patch" many web APIs in order to save and restore snapshots, which adds
startup cost and scales poorly as new web APIs been added.

## General approach to web API semantics with AsyncContext

For web APIs that take callbacks, the context of the callback is determined by
where the callback is effectively caused from. This is usually the point where
the API was invoked.

```js
{
  /* context 1 */
  callAPIWithCallback(() => {
    // context 1
  });
}
```

There are various kinds of web platform APIs that accept callbacks and at a later
point run them. And in some cases there is more than one incoming data flow, and
therefore multiple possible `AsyncContext.Snapshot`s that could be restored:

```javascript
{
  /* context 1 */
  giveCallbackToAPI(() => {
    // What context here?
  });
}
{
  /* context 2 */
  callCallbackGivenToAPI();
}
```

APIs should call callbacks using the context from where the API is effectively scheduled
the task (`context 2` in the above code snippet). This matches the behavior you'd get
if web APIs were implemented in JavaScript internally using only promises and
callbacks. This will thus match how most userland libraries behave.

Some callbacks can be _sometimes_ triggered by some JavaScript code that we can propagate
the context from, but not always. An example is `.addEventListener`: some events can only
be triggered by JavaScript code, some only by external causes (e.g. user interactions),
and some by either (e.g. user clicking on a button or the `.click()` method). In these
cases, when the action is not triggered by some JavaScript code, the callback will run
in the **empty context** instead (where every `AsyncContext.Variable` is set to its default
value). This matches the behavior of JavaScript code running as a top-level operation (like
JavaScript code that runs when a page is just loaded).

In the rest of this document, we look at various kinds of web platform APIs
which accept callbacks or otherwise need integration with AsyncContext, and
examine which context should be propagated.

# Individual analysis of web APIs and AsyncContext

For web APIs that take callbacks, the context in which the callback is run would
depend on the kind of API:

## Schedulers

These are web APIs whose sole purpose is to take a callback and schedule it in
the event loop in some way. The callback will run asynchronously at some point,
when there is no other JS code in the call stack.

For these APIs, there is only one possible context to propagate: the one that
was active when the API was called. After all, that API call starts a background
user-agent-internal operation that results in the callback being called.

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

## Async completion callbacks

These web APIs start an asynchronous operation, and take callbacks to indicate
that the operation has completed. These are usually legacy APIs, since modern
APIs would return a promise instead.

These APIs propagate the context from where the web API is called, which is the point that
starts the async operation. This would also make these callbacks behave the same as they would
when passed to the `.then()` method of a promise.

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
and then they were changed to return a promise – e.g. `BaseAudioContext`'s
`decodeAudioData()` method. For those APIs, the callback's context would behave
similarly to other async completion callbacks, and the promise rejection context
would behave similarly to other promise-returning web APIs (see below).

### Callbacks run as part of an async algorithm

These APIs always invoke the callback to run user code as part of an
asynchronous operation that they start, and which affects the behavior of the
operation. These callbacks are also caused by the original call to the web API,
and thus run in the context that was active at that moment.

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

> [!TIP]
> In all these cases actually propagating the context through the internal asynchronous
> steps of the algorithms gives the same result as capturing the context when the API
> is called and storing it together with the callback. This applies both to "completion
> callbacks" and to "progress callbacks".


## Events

Events are a single API that is used for a great number of things, including
cases which have a clear JavaScript-originating cause, and cases which the
callback is almost always triggered as a consequence of user interaction.

For consistency, event listener callbacks should be called with the dispatch
context. If that does not exist, the empty context should be used, where all
`AsyncContext.Variable`s are set to their initial values.

Event dispatches can be one of the following:
- **Synchronous dispatches**, where the event dispatch happens synchronously
  when a web API is called. Examples are `el.click()` which synchronously fires
  a `click` event, setting `location.hash` which synchronously fires a
  `popstate` event, or calling an `EventTarget`'s `dispatchEvent()` method. For
  these dispatches, the TC39 proposal's machinery is enough to track the
  context from the API that will trigger the event, with no help from web specs
  or browser engines.
- **Browser-originated dispatches**, where the event is triggered by browser or
  user actions, or by cross-agent JS, with no involvement from JS code in the
  same agent. Such dispatches can't have propagated any context from some non-existing
  JS code that triggered them, so the listener is called with the empty context.
- **Asynchronous dispatches**, where the event originates from JS calling into
  some web API, but the dispatch happens at a later point. In these cases, the
  context should be tracked along the data flow of the operation, even across
  code running in parallel (but not through tasks enqueued on other agents'
  event loops).

For events triggered by JavaScript code (either synchronously or asynchronously),
the goal is to follow the same principle state above: they should propagate the
context as if they were implemented by a JavaScript developer that is not explicitly
thinking about AsyncContext propagation: listeners for events dispatched either
**synchronously** or **asynchronously** from JS or from a web API would use the context
that API is called with.

<details>
<summary>Expand this section for examples of the equivalent JS-authored code</summary>

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

> [!WARNING]
> To keep agents isolated, events dispatched from different agents (e.g. from a worker, or from a cross-origin iframe) will behave like events dispatched by user interaction. This also applies to events dispatched from cross-origin iframes in the same agent, to avoid exposing the fact that they're in the same agent.

## Status change listener callbacks

These APIs register a callback or constructor to be invoked when some action
runs. They're also commonly used as a way to associate a newly created class
instance with some action, such as in worklets or with custom elements.

In cases where the action always originates due to something happening outside of
the web page (such as some user action), there is never some JS code that triggers
the callback. These would behave like async-completion/progress APIs,
that propagate the context from the point where the API is called (making, for
example, `navigator.geolocation.watchPosition(cb)` propagate the same way as
`navigator.geolocation.getCurrentPosition(cb)`).

- [`navigator.mediaSession.setActionHandler()`](https://w3c.github.io/mediasession/#dom-mediasession-setactionhandler)
  method [\[MEDIASESSION\]](https://w3c.github.io/mediasession/)
- [`navigator.geolocation.watchPosition()`](https://w3c.github.io/geolocation/#dom-geolocation-watchposition)
  method [\[GEOLOCATION\]](https://w3c.github.io/geolocation/)
- [`RemotePlayback`](https://w3c.github.io/remote-playback/#dom-remoteplayback):
  [`watchAvailability()`](https://w3c.github.io/remote-playback/#dom-remoteplayback-watchavailability)
  method [\[REMOTE-PLAYBACK\]](https://w3c.github.io/remote-playback/)

### Worklets

Worklets work similarly: you provide a class to an API that is called
_always from outside of the worklet thread_ when there is some work to be done.

- [`registerProcessor()`](https://webaudio.github.io/web-audio-api/#dom-audioworkletglobalscope-registerprocessor)
- [`registerPaint()`](https://drafts.css-houdini.org/css-paint-api-1/#dom-paintworkletglobalscope-registerpaint)

While in theory there always is only one possible context to propagate to the class methods,
that is the one when `.register*()` was called (because there is never in-thread JS code actually
calling those methods), in practice that context will always match the root context of the
worklet scope (because `register*()` is always called at the top-level). Hence, to simplify
implementations we propose that Worklet methods always run in the root context.

According to the HTML spec, creating a worklet global scope always creates a new agent, and
therefore there can't be any propagation from other context into the worklet and vice versa, even
if its event loop runs in the same thread as other agents. This isn't always implemented this way –
in Chromium, for example, the equivalent of an agent is shared among worklets and other agents
running in the same thread; but since this agent sharing is unobservable, we should not add a
dependency on it.

### Custom elements

Custom elements are also registered by passing a class to a web API, and this class
has some methods that are called at different points of the custom element's lifecycle.

However, differently from worklets, lifecycle callbacks are almost always triggered
synchronously by a call from userland JS to an API annotated with
[`[CEReactions]`](https://html.spec.whatwg.org/multipage/custom-elements.html#cereactions).
We thus propose that they behave similarly to events, running in the same context that was
active when the API that triggers the callback was called.

There are cases where lifecycle callbacks are triggered by user interaction, so there is no
context to propagate:

- If a custom element is contained inside a `<div contenteditable>`, the user
  could remove the element from the tree as part of editing, which would queue a
  microtask to call its `disconnectedCallback` hook.
- A user clicking a form reset when a form-associated custom element is in the
  form would queue a microtask to call its `formResetCallback` lifecycle hook,
  and there would not be a causal context.

Similarly to events, in this case lifecycle callbacks would run in the empty context.

## Observers

Observers are a kind of web API pattern where the constructor for a class takes
a callback, the instance's `observe()` method is called to register things that
should be observed, and then the callback is called when those observations have
been made.

Observer callbacks are not called once per observation. Instead, multiple observations
can be batched into one single call. This means that there is not always a single JS action
that causes some work that eventually triggers the observer callback; rather, there might be many.

Given this, observer callbacks should always run with the empty context. This can be explained
by saying that, e.g. layout changes are always considered to be a browser-internal trigger, even if
they were caused by changes injected into the DOM or styles through JavaScript.

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

> [!NOTE]
> An older version of this proposal suggested to capture the context at the time the observer
> is created, and use it to run the callback. This has been removed due to memory leak concerns.

In some cases it might be useful to expose the causal context for individual
observations, by exposing an `AsyncContext.Snapshot` property on the observation
record. This should be the case for `PerformanceObserver`, where
`PerformanceEntry` would expose the snapshot as a `resourceContext` property. This
is not included as part of this initial proposed version, as new properties can
easily be added as follow-ups in the future.

## Stream underlying APIs

The underlying [source](https://streams.spec.whatwg.org/#underlying-source-api),
[sink](https://streams.spec.whatwg.org/#underlying-sink-api) and
[transform](https://streams.spec.whatwg.org/#transformer-api) APIs for streams
are callbacks/methods passed during stream construction.

The `start` method runs as a direct consequence of the stream being constructed,
thus it propagates the context from there. For other methods there would be a
different causal context, depending on what causes the call to that method. For example:

- If `ReadableStreamDefaultReader`'s `read()` method is called and that causes a
  call to the `pull` method, then that would be its causal context. This would
  be the case even if the queue is not empty and the call to `pull` is deferred
  until previous invocations resolve.
- If a `Request` is constructed from a `ReadableStream` body, and that is passed
  to `fetch`, the causal context for the `pull` method invocations should be the
  context active at the time that `fetch` was called. Similarly, if a response
  body `ReadableStream` obtained from `fetch` is piped to a `WritableStream`,
  its `write` method's causal context is the call to `fetch`.

In general, the context that should be used is the one that matches the data
flow through the algorithms ([see the section on implicit propagation
below](#implicit-context-propagation)).

> TODO: Piping is largely implementation-defined. We will need to explicitly
> define how propagation works there, rather than relying on the streams
> usage of promises, to ensure interoperability.

> TODO: If a stream gets transferred to a different agent, any cross-agent
> interactions will have to use the empty context. What if you round-trip a
> stream through another agent?

## Script errors and unhandled rejections

The `error` event on a window or worker global object is fired whenever a script
execution throws an uncaught exception. The context in which this exception was
thrown is the causal context where the exception is not handled. Likewise, the
`unhandledrejection` is fired whenever a promise is rejected without a rejection
handler, and the causal context is the context where the promise was created.

Having access to the contexts which these errors are not handled is useful to
determine which of multiple independent streams of async execution did not handle
the errors properly, and therefore how to clean up after it. For example:

```js
async function doOperation(i: number, signal: AbortSignal) {
  // ...
}

const operationNum = new AsyncContext.Variable();
const controllers: AbortController[] = [];

for (let i = 0; i < 20; i++) {
  controllers[i] = new AbortController();
  operationNum.run(i, () => setTimeout(() => doOperation(i, controllers[i].signal), 0));
}

window.onerror = window.onunhandledrejection = () => {
  const idx = operationNum.get();
  controllers[idx].abort();
};
```

### Unhandled rejection details

In the following example, an `unhandledrejection` event would be fired due to the
promise returned by `b()` rejecting without a handler. The context propagated to
the `unhandledrejection` handler would be the one active when `b()` was called,
which is the outer `asyncVar.run("foo", ...)` call, and thus `asyncVar` would
map to `"foo"`, rather than `"bar"` where the throw happens.

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

If a promise created by a web API rejects, the `unhandledrejection` event
handlers context would be tracked following the normal tracking mechanism. According to the
categories in the ["Writing Promise-Using Specifications"](https://w3ctag.github.io/promises-guide/) guide:
- For one-and-done operations, the rejection-time context of the returned
  promise should be the context when the web API that returns it was called.
- For one-time "events", the rejection context would be the context in which the
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
- More general state transitions are similar to one-time "events" which can be
  reset, and so they should behave in the same way.

## Module evaluation

When you import a JS module multiple times, it will only be fetched and
evaluated once. Since module evaluation should not be racy (i.e. it should not
depend on the order of various imports), the context should be reset so that
module evaluation always runs with the empty AsyncContext snapshot.

## Security Considerations

The goal of the AsyncContext web integration is to propagate context inside
a same-origin web page, and not to leak information across origins or agents.

The propagation must not implicitly serialize and deserialize context values
across agents, and no round-trip propagation. The propagation must not involve
code execution in other agents.

### Cross-document navigation

When a cross-document navigation happens, even if it is same-origin, the context
will be reset such that document load and tasks that directly flow from it
(including execution of classic scripts found during parsing) run with the
empty AsyncContext snapshot, which will be an empty mapping (i.e. every
`AsyncContext.Variable` will be set to its initial value).

### Cross-origin iframes

Cross-origin API calls do not propagate the context from one origin to the other,
as if they were happening in different agents/threads. This is also true for APIs
that synchronously run cross-origin code, such as calling `.focus()` on a
cross-origin iframe's window: the context is explicitly reset to the top-level one.

See [whatwg/html#3506](https://github.com/whatwg/html/issues/3506) for related
discussion about `focus()`'s behavior on cross-origin iframes.

# Editorial aspects of AsyncContext integration in web specifications

An agent always has an associated AsyncContext mapping, in its
`[[AsyncContextMapping]]` field[^1]. When the agent is created, this mapping will be
set to an HTML-provided initial state, but JS user code can change it in a
strictly scoped way.

[^1]: The reason this field is agent-wide rather than per-realm is so calling a
function from a different realm which calls back into you doesn't lose the
context, even if the functions are async.

In the current proposal, the only way JS code can modify the current mapping is
through `AsyncContext.Variable` and `AsyncContext.Snapshot`'s `run()` methods,
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

We propose adding a web spec algorithm "run the AsyncContext Snapshot", that could be used like this:

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

For web APIs that take a callback and eventually call it with the same context as when
the web API was called, this should be handled in WebIDL by storing the result of `AsyncContextSnapshot()`
alongside the callback function, and swapping it when the function is called. Since this should not happen
for every callback, there should be a WebIDL extended attribute applied to callback types to control this.

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
  and `signal` arguments will be "inherited" from the call to `postTask`. This
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
algorithms will be added to the TC39 proposed spec text, so that web specs don't
need to create JS objects.
