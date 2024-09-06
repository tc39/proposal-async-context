# Introduction

The purpose of this document is to explain the integration of AsyncContext with
the web platform. In particular, when a callback is run, what values do
`AsyncContext.Variable`s have? In other words, which `AsyncContext.Snapshot` is
restored?

Generally, our proposed answer is, “the same context that was active when the
callback was passed in as a parameter”. This answer is expected to have the
simplest mental model for developers, matching `async`/`await`, compared to
alternatives considered. Its regularity makes it simple to specify and
implement.

In certain cases, there is another relevant `AsyncContext.Snapshot`, which can
be passed on the side where it is found to be useful, e.g., as a property of
certain `Event`s. These properties can be added incrementally over time as they
are found to be useful, rather than all in one go with the initial proposal.

Although this document focuses on the web platform, and on web APIs, it is also
expected to be relevant to other JavaScript environments and runtimes. This will
necessarily be the case for [WinterCG](https://wintercg.org)-style runtimes,
since they will implement web APIs. However, the integration with the web
platform is also expected to serve as a model for other APIs in other JavaScript
environments.

## Background

AsyncContext is a stage 2 TC39 proposal that allows associating state implicitly
with a call stack, such that it propagates across asynchronous tasks and promise
chains. In a way it is the equivalent of thread-local storage, but for async
tasks. APIs like this (such as Node.js’s `AsyncLocalStorage`, on which API
`AsyncContext` is based on) are fundamental for a number of diagnostics tools
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

The AsyncContext API isn’t designed to be used directly by JavaScript
developers, but rather as an implementation detail of certain libraries.
AsyncContext makes it so users of those libraries don’t need to explicitly
integrate with it. Instead, the AsyncContext mechanism handles implicitly
passing contextual data around.

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

Note that in some cases there are multiple incoming data flows, and therefore
multiple possible `AsyncContext.Snapshot`s that could be restored. For example,
rather than saving the snapshot when a callback is passed in, the snapshot could
be saved when invoking an algorithm which will queue a task that runs that
callback. In some cases, this choice would have different observable behavior,
and the information from this other snapshot might be causally relevant.

Note that in a number of cases, it is possible for one of the data flow paths to
either have or not have an associated context due to causes that are not obvious
from the code that would run in that context. For example, `el.click()` and a
user click on the `el` element both fire a `click` event, but the user click
does not have a context to go back to, since it does not originate in JS. In
these cases, the difference between these cases should not be exposed as the
context the callback/method runs in, but it might be exposed in some other way.

**We therefore propose that, every time a callback is passed to a web API, its
`AsyncContext.Snapshot` is saved at that time, and it is restored when the
callback is run.** Spec-wise, this could be handled in the definition of
callback functions and callback interface types in WebIDL.

This document examines various kinds of web platform APIs which accept callbacks
or otherwise need integration with AsyncContext, and examines whether the
developer-facing behavior is as one would logically expect. In cases where there
is a different causally related snapshot, it also considers whether that other
snapshot should be exposed via another web platform API.

# Individual analysis of web APIs and AsyncContext

Is it really correct to wrap all callbacks which are passed into WebIDL such
that they restore the AsyncContext snapshot from when they were initially
provided? Are other snapshots relevant to provide on the side? This section
examines many web APIs, case by case, and concludes that the initial snapshot is
appropriate for the invocation of the callback, suggesting certain cases where
other contexts should also be provided with explicit APIs.

## Web APIs that take callbacks

For web APIs that take callbacks, the context in which the callback is run would
depend on the kind of API:

### Schedulers

These are web APIs whose sole purpose is to take a callback and schedule it in
the event loop in some way. The callback will run asynchronously at some point,
when there is no other JS code in the call stack.

Because there is no other relevant snapshot to consider restoring, the general
mechanism of saving and restoring the snapshot at the WebIDL callback level is
correct and sufficient. These APIs should store the context at the time that
they are called, and invoke the callback with that context.

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

Since such callbacks behave like the callbacks passed to the `.then()` method of
promises, they should behave similarly by invoking them with the context with
which the API is called.

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
operation. If the callbacks are always run asynchronously, then they should also
use the context in which the API was called:

- [`Document`](https://dom.spec.whatwg.org/#document):
  [`startViewTransition()`](https://drafts.csswg.org/css-view-transitions-2/#dom-document-startviewtransition)
  method [\[CSS-VIEW-TRANSITIONS-1\]](https://drafts.csswg.org/css-view-transitions-1/)
- [`LockManager`](https://w3c.github.io/web-locks/#lockmanager):
  [`request()`](https://w3c.github.io/web-locks/#dom-lockmanager-request) method
  [\[WEB-LOCKS\]](https://w3c.github.io/web-locks/)

You can see these APIs as implementable in JS like this, and they should behave the same:
```js
async function api(callback) {
  await doSomething();
  await callback();
  await doSomethingElse();
}
```

Some APIs take callbacks that could be seen as running as part of an async
algorithm, but the callbacks might also run in response to some other web API,
which can have a different context. In those cases, the callbacks should still
run in the context in which the web API that started the algorithm was called.
However, it might also be useful in some cases to make the synchronous context
available to the callback, for example by passing an `AsyncContext.Snapshot` as
an additional argument. Some examples:

- The underlying [source](https://streams.spec.whatwg.org/#underlying-source-api)
  / [sink](https://streams.spec.whatwg.org/#underlying-sink-api) /
  [transform](https://streams.spec.whatwg.org/#transformer-api) APIs for streams
  [\[STREAMS\]](https://streams.spec.whatwg.org). Other than the `start` method,
  which is always invoked synchronously when the stream is constructed, the
  other underlying API methods are invoked in response to operations on the
  stream. These operations might have a synchronous cause such as JS code
  calling `reader.read()`, or an asynchronous cause such as JS code calling
  `await new Response(stream).text()`, and it might be useful to provide the
  context for such causes to the callback – for example, by adding an extra
  `AsyncContext.Snapshot` argument to the methods. This might be left for later,
  rather than being part of the initial rollout.

- [`NavigateEvent`](https://html.spec.whatwg.org/multipage/nav-history-apis.html#navigateevent):
  [`intercept()`](https://html.spec.whatwg.org/multipage/nav-history-apis.html#dom-navigateevent-intercept)
  method [\[HTML\]](https://html.spec.whatwg.org/multipage/). Immediately after
  the navigate event is dispatched, any handlers registered with `intercept()`
  will be invoked. Since the event can be dispatched synchronously (e.g. by
  setting [`location.href`](https://html.spec.whatwg.org/multipage/nav-history-apis.html#dom-location-href)),
  there might be JS code on the call stack. But in this case that might not be
  useful to expose, since the call to `intercept()` can be seen as scheduling
  those callbacks, and the fact that there is JS code on the call stack can be
  seen as an implementation detail.

### Action registrations

These APIs register a callback or constructor to be invoked when some action
runs. They’re also commonly used as a way to associate a newly created class
instance with some action, such as in worklets or with custom elements.

In cases where the action that causes the callback or constructor to be invoked
originates with the browser, not being caused by any JS code, then the callback
will have the same context as when the API that registered it was called. For
worklets, only JS code inside the worklet counts as causing the action. In these
cases, there is no other AsyncContext snapshot to consider using besides the one
which was active when the API was called, so the generic WebIDL solution works.

- [`navigator.mediaSession.setActionHandler()`](https://w3c.github.io/mediasession/#dom-mediasession-setactionhandler)
  method [\[MEDIASESSION\]](https://w3c.github.io/mediasession/)
- [`navigator.geolocation.watchPosition()`](https://w3c.github.io/geolocation/#dom-geolocation-watchposition)
  method [\[GEOLOCATION\]](https://w3c.github.io/geolocation/)
- [`RemotePlayback`](https://w3c.github.io/remote-playback/#dom-remoteplayback):
  [`watchAvailability()`](https://w3c.github.io/remote-playback/#dom-remoteplayback-watchavailability)
  method [\[REMOTE-PLAYBACK\]](https://w3c.github.io/remote-playback/)
- [`AudioWorkletGlobalScope`](https://webaudio.github.io/web-audio-api/#AudioWorkletGlobalScope):
  [`registerProcessor()`](https://webaudio.github.io/web-audio-api/#dom-audioworkletglobalscope-registerprocessor)
  method [\[WEBAUDIO\]](https://webaudio.github.io/web-audio-api/)
- [`PaintWorkletGlobalScope`](https://drafts.css-houdini.org/css-paint-api-1/#paintworkletglobalscope):
  [`registerPaint()`](https://drafts.css-houdini.org/css-paint-api-1/#dom-paintworkletglobalscope-registerpaint)
  method [\[CSS-PAINT-API\]](https://drafts.css-houdini.org/css-paint-api-1/)

In the case of custom elements, the actions that invoke the custom element
methods are usually triggered from JS code calling a web API, e.g. removing a
custom element with `el.remove()` will cause its `disconnectedCallback` method
to be run. But in some cases custom element reactions can also run as a response
to a user action, such as removing a custom element inside a text editing
context. To avoid having a difference between these cases, we propose using the
context in which the custom element was defined with
[`customElements.define()`](https://html.spec.whatwg.org/multipage/custom-elements.html#dom-customelementregistry-define)
[\[HTML\]](https://html.spec.whatwg.org/multipage/). In the future it might be
possible to add a way to get the snapshot in which el.remove() was invoked, if
there are use cases.

In the cases where the registration web API takes a constructor, the methods and
getters of the returned object (e.g. the `processor` method in web audio
worklets, or the `attributeChangedCallback` method of custom elements) also
count as callbacks that these APIs invoke, and which should preserve the
relevant context.

### Observers

Observers should store the context at the time the observer class is
constructed, and call the callback with that context:

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

There often are other relevant context snapshots to restore, but these would
actually be per observation record, rather than across the whole callback. For
that reason, for some observers, such as `PerformanceObserver`, it might be
useful to expose to the user the context in which the observation record was
captured, if any. This can be done by exposing an `AsyncContext.Snapshot`
instance on the observation record (e.g. on `PerformanceEntry`).

## Events

Events might have up to two contexts that matter:

- The **registration context** is the context active when the event listener was
  registered with [`addEventListener()`](https://dom.spec.whatwg.org/#dom-eventtarget-addeventlistener),
  by setting an event handler property (e.g. `el.onclick`), or by changing an
  event handler attribute (e.g. `<button onclick="handle()">`). Every time that
  an event listener is invoked, there is a registration context.

- The **dispatch context**, which is the context of the JS code that actually
  causes the event to fire, if any. When it exists, it can be of two kinds:

  * The **sync dispatch context** is the context active when the event is
    dispatched, if there is some JS code on the stack that caused it to be
    dispatched. If there is no JS code on the stack, there is no sync dispatch
    context.

    Examples of cases where there would be a sync dispatch context:
    - [`el.click()`](https://html.spec.whatwg.org/multipage/interaction.html#dom-click)
      will synchronously fire a `click` event
    - Setting [`location.hash`](https://html.spec.whatwg.org/multipage/nav-history-apis.html#dom-location-hash)
      will synchronously cause a same-document navigation which fires a
      `popstate` event on the window object.

  * In cases where a web API queues a task to fire an event, or starts an
    asynchronous or parallel operation that will ultimately queue such a task,
    the context in which that web API is called is the **async dispatch
    context** for that event. (If there is a sync dispatch context, that usually
    takes priority over an async context.)

    Examples of cases where there would be an async dispatch context:
    - [`xhr.send()`](https://xhr.spec.whatwg.org/#dom-xmlhttprequest-send),
      which starts an asynchronous fetch which will eventually fire the various
      XHR events (e.g. `load`).
    - Setting `img.src`, which starts an asynchronous image load which will
      eventually fire the `load` event.

  In cases where an event is caused by a user interaction, or otherwise
  triggered by the browser, there is no dispatch context, whether sync or async.
  Examples are:
  - A `click` event caused by a user click.
  - The `offline` and `online` events on the window object, which are fired when
    the browser detects a change of network connectivity.
  - Events caused by JS code outside the agent, such as a `message` event coming
    from a worker.

When an event listener is added, the registration context will be saved along
with the listener, and when the event is dispatched, each listener will be
called in its registration context. This fits the general scheme of storing the
snapshot when the callback is passed to a web API, and running the callback in
that snapshot.

However, for certain events, the dispatch context might be important for
authors. In those cases, we propose extending specific Event subclasses with a
property containing an `AsyncContext.Snapshot` object. In cases where there
might or might not be a dispatch snapshot (e.g. the `click` event, which would
have a dispatch snapshot if it originates from `el.click()` but not if it
originates from a user click), this property would be `null` if there isn’t one.
Note that the web platform can start out conservatively adding these properties
only for certain `Event` subclasses, and incrementally add support for more
later.

For `Event` subclasses in which this property is nullable, constructing them
from JavaScript should set that property to `null`. It might be possible to
extend the constructor’s options bag to allow capturing the snapshot at
construction time, but this would not be part of the initial rollout. For
subclasses where the property is not nullable, calling the constructor could
capture the snapshot. Another possibility is to always have this property as
nullable, even for event types where there is always a dispatch context.

### Dispatch snapshots for events created from JavaScript

When an event is created from JavaScript, the `dispatchSnapshot` will be
automatically set based on the current `AsyncContext.Snapshot` where the event
was allocated. A flag could be added to `EventInit` so the `dispatchSnapshot` is
`null`, to allow polyfilling events without a dispatch context; although it
could also be useful for the default behavior of that flag to depend on the
particular `Event` subclass.

An alternative approach would be to populate the `dispatchSnapshot` property
when the event is dispatched, with the context in which it is dispatched. This
is similar to the behavior of `currentTarget` or `eventPhase`. However, the
dispatch context would stay the same across an event dispatch, whereas those
properties will change. Furthermore, in most cases where events are created and
dispatched from JavaScript, the creation and dispatch happen in the same
context. So we don’t recommend this approach.

### Design principles for dispatch snapshots

In some cases, a single event might have multiple async dispatch contexts as its
possible causes, because the incoming data flow for that event might have
multiple branches that go back to different script executions. This is
particularly important when the data flow in implementations is expected to be
different from the spec in relevant ways.

An example of this is HTML media playback events, where if the user clicks play,
and in short succession JS code calls `videoEl.load()` and then `videoEl.play()`
in two different contexts, all three data flow branches will merge, resulting in
a single `load` event being fired.

If some of those sources are browser-originated and some originate from JS, only
the latter ones should be considered. Beyond that, each such individual event
would have to be considered. For media playback events, this merge is caused by
debouncing (i.e. if a load is already in progress, calling a method that would
start one will reuse the existing one), and so the dispatch context should be
that for the earliest web API call that resulted in this event. But other cases
might have other needs, and their specifics need to be considered.

## Runtime script errors

The `error` event on a window or worker global object is fired whenever a script
execution throws an uncaught exception. Having access to the context in which
the exception was thrown can help determine which of multiple independent
streams of execution triggered this error, and therefore how to clean up after
it. Therefore,
[`ErrorEvent`](https://html.spec.whatwg.org/multipage/webappapis.html#errorevent)
will have a `throwSnapshot` property, reflecting the context in which the
exception was thrown.


## Promises / async web APIs

The `unhandledrejection` event on a window or worker global object is fired
whenever a promise resolves with a rejection, without having a rejection handler
registered. Exposing the context in which the promise was rejected is useful for
the same reasons as for runtime script errors. Therefore,
[`PromiseRejectionEvent`](https://html.spec.whatwg.org/multipage/webappapis.html#promiserejectionevent)
will have a `rejectionSnapshot` property reflecting this context.

In the case of promises created by web APIs, it seems the rejection context
would always be the same as the context when the promise is created. According
to the categories in the [“Writing Promise-Using
Specifications”](https://w3ctag.github.io/promises-guide/) guide:
- For one-and-done operations, the rejection-time context of the returned
  promise should be the context when the web API that returns it was called.
- For one-time “events”, the promise is created at the same time as an async
  operation is started which will eventually resolve it, so the context would
  flow from creation to rejection. E.g, for the
  [`loaded`](https://drafts.csswg.org/css-font-loading-3/#dom-fontface-loaded)
  property of a [`FontFace`](https://drafts.csswg.org/css-font-loading-3/#fontface)
  instance, creating the `FontFace` instance causes both the promise creation
  and the loading of the font.
- More general state transitions are similar to one-time “events” in that each
  promise is created at the same time as an async operation starts that will
  resolve it.

## Cross-document navigations

When a cross-document navigation happens, even if it is same-origin, the context
will be reset such that document load and tasks that directly flow from it
(including execution of classic scripts found during parsing) run with the
initial AsyncContext snapshot. The initial AsyncContext Snapshot will be
provided by the host environment (i.e. by the HTML spec, for the web), and it
should either be empty, or only have mappings from spec-defined
`AsyncContext.Variable`s (see “Using AsyncContext from web specs” below).

## Module evaluation

When you import a JS module multiple times, it will only be fetched and
evaluated once. Since module evaluation should not be racy (i.e. it should not
depend on the order of various imports), the context should be reset so that
module evaluation always runs with the initial AsyncContext snapshot. Inside of
`ShadowRealm`s, the AsyncContext snapshot for all module evaluations will be the
snapshot which was active when the `ShadowRealm` was created.

# Editorial aspects of AsyncContext integration in web specifications

An agent always has an associated AsyncContext mapping, in its
`[[AsyncContextMapping]]` field. When the agent is created, this mapping will be
set to an HTML-provided initial state, but JS user code can change it in a
strictly scoped way.

The only way JS code can modify the current mapping is through
`AsyncContext.Variable` and `AsyncContext.Snapshot`’s `run()` methods, which
switch the context before calling a callback and switch it back after it
synchronously returns or throws. This ensures that for purely synchronous
execution, the context is automatically propagated along the data flow. It is
when tasks and microtasks are queued that web specs must manually track the data
flow.

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

It might also be possible to integrate “run the AsyncContext Snapshot” together
with task queueing, since running an AsyncContext Snapshot inside a task will be
a very common operation.

Since the AsyncContext mapping is a property of the agent, these operations are
not available in parallel. However, web spec algorithms that run steps in
parallel before queuing a task that will run JS code must still track the data
flow along the parallel execution. However, in many cases this will mean
propagating the snapshotted context along with a callback through the parallel
algorithms, which will be handled automatically by WebIDL.

AsyncContext mappings also cannot be sent to a different agent. If the data flow
for some script execution or callback invocation originates from a different
agent, no context should be restored for that execution. In the case of an
event, the event would not have a dispatch context.

## Events

By default, the [“create an event”](https://dom.spec.whatwg.org/#concept-event-create)
algorithm, and [“fire an event”](https://dom.spec.whatwg.org/#concept-event-fire)
which wraps it, will create the event with dispatchSnapshot set to null. These
algorithms will be extended with an optional boolean argument
_**populateDispatchSnapshot**_ (default false) that will cause
`dispatchSnapshot` to instead be set to the current AsyncContext mapping.
[\[DOM\]](https://dom.spec.whatwg.org/)

For events with a sync dispatch context, setting this argument to true will be
enough. For events with an asynchronous dispatch context, that context will have
to be set as the current context first:

> 1. Let _context_ be [AsyncContextSnapshot](https://tc39.es/proposal-async-context/#sec-asynccontextsnapshot)().
> 1. [Queue a global task](https://html.spec.whatwg.org/multipage/webappapis.html#queue-a-global-task)
>    to run the following steps:
>    1. Run the AsyncContext Snapshot _context_ while performing the following
>       steps:
>       1. [Fire an event](https://dom.spec.whatwg.org/#concept-event-fire)
>          named `foo`, with _**populateDispatchSnapshot**_ set to true, at
>          _target_.

## Runtime script errors

One important part of the way AsyncContext works is strict stacking – you can
only switch into a context by calling a function, which restores the previous
context when it returns or throws. This, however, would make exposing the throw
context in the error event impossible, since the spec text that calls into JS
would not have a way to get that throw context, if it is different from the
context that the spec text set for that JS execution.

To allow the error event to have the throw context,
[PR #95](https://github.com/tc39/proposal-async-context/pull/95) on the
AsyncContext proposal adds a `[[ThrowAsyncContextMapping]]` field on the agent
record. This field might still be set to `EMPTY` even when an exception was
thrown, but in those cases the throw context will be the same as the current
context.

The `error` event is fired through the
[“report an error”](https://html.spec.whatwg.org/multipage/webappapis.html#report-the-error)
and [“report an exception”](https://html.spec.whatwg.org/multipage/webappapis.html#report-the-exception)
spec algorithms [\[HTML\]](https://html.spec.whatwg.org/multipage/), which are
usually called immediately after a script execution or callback invocation.
Those algorithms will be updated to use `[[ThrowAsyncContextMapping]]` to get
the throw context, but in order to have the right context even when it is
`EMPTY`, they must be called before the call to `AsyncContextSwap()` that exits
the context in which the script is run:

> 1. Let _context_ be [AsyncContextSnapshot](https://tc39.es/proposal-async-context/#sec-asynccontextsnapshot)().
> 1. [Queue a global task](https://html.spec.whatwg.org/multipage/webappapis.html#queue-a-global-task)
>    to run the following steps:
>    1. Run the AsyncContext Snapshot _context_ while performing the following
>       steps:
>       1. Perform some algorithm, which might call into JS. If this throws an
>          exception, catch it, and
>          [report the exception](https://html.spec.whatwg.org/multipage/webappapis.html#report-the-exception).

## Promises

Since the rejection context of web spec-created promises seems to always be the
context in which the promises are created, it might be good to update WebIDL so
that [creating a new promise](https://webidl.spec.whatwg.org/#a-new-promise)
stores the current context, and restores it when
[rejecting](https://webidl.spec.whatwg.org/#reject) it.

## Exposing snapshots to JS code

Anytime that a web spec needs to expose a context other than the current one
when some code is run, such as the dispatch context for events or observer
entries, it should be exposed as an `AsyncContext.Snapshot` object. The
AsyncContext proposal has the
[`CreateAsyncContextSnapshot()`](https://tc39.es/proposal-async-context/#sec-createasynccontextsnapshot)
abstract operation for this, which takes a mapping and returns an
`AsyncContext.Snapshot` instance.

For snapshots exposed as properties of events, observer entries or other web
platform objects, `CreateAsyncContextSnapshot()` should be called in the
relevant realm of that web platform object. In any other cases (e.g. if a
snapshot is passed as an argument into a callback), it should be called in the
relevant realm of `this` (see https://github.com/whatwg/webidl/issues/135). It
might therefore make sense to instead define an equivalent of that abstract
operation in WebIDL, that handles this.

Note that for properties of events and observer entries, implementations may
allocate the actual `AsyncContext.Snapshot` instance lazily on first access, if
they just store the internal pointer to the underlying snapshot when the event
is created.

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

Each of these use cases would need to define `AsyncContext.Variable` instances
that would be spec-internal and not exposed to JS code. Algorithms are expected
to be added, either to the TC39 proposed spec text, or to some of the web specs,
to make it simpler to use them.
