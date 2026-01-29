# AsyncContext integration with web platform APIs

## TOC

- [Introduction](#introduction)
- [Background](#background)
- [General approach to web API semantics with AsyncContext](#general-approach-to-web-api-semantics-with-asynccontext)
- [Individual analysis of web APIs and AsyncContext](#individual-analysis-of-web-apis-and-asynccontext)
   * [Schedulers](#schedulers)
   * [Async completion callbacks](#async-completion-callbacks)
   * [Events](#events)
      + [Events by dispatch timing](#events-by-dispatch-timing)
         - [Synchronous event dispatches](#synchronous-event-dispatches)
         - [Externally-caused event dispatches](#externally-caused-event-dispatches)
         - [Asynchronous event dispatches](#asynchronous-event-dispatches)
      + [Summary of event propagation rules](#summary-of-event-propagation-rules)
      + [Previously discarded approaches for events](#previously-discarded-approaches-for-events)
         - [Capture the context when the event listener is registered](#capture-the-context-when-the-event-listener-is-registered)
         - [Always propagate from APIs that dispatch events](#always-propagate-from-apis-that-dispatch-events)
         - [Propagate only for a fixed set of events](#propagate-only-for-a-fixed-set-of-events)
         - [Opt-in propagation from APIs that dispatch events](#opt-in-propagation-from-apis-that-dispatch-events)
   * [Status change listener callbacks](#status-change-listener-callbacks)
      + [Worklets](#worklets)
      + [Custom elements](#custom-elements)
   * [Observers](#observers)
   * [Stream underlying APIs](#stream-underlying-apis)
   * [Module evaluation](#module-evaluation)
   * [Security Considerations](#security-considerations)
- [Editorial aspects of AsyncContext integration in web specifications](#editorial-aspects-of-asynccontext-integration-in-web-specifications)
   * [Using AsyncContext from web specs](#using-asynccontext-from-web-specs)

## Introduction

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
callbacks. This will thus match how most userland libraries behave. It also matches what
would happen by default if the API was synchronous.

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

## Individual analysis of web APIs and AsyncContext

For web APIs that take callbacks, the context in which the callback is run would
depend on the kind of API:

### Schedulers

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

### Async completion callbacks

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

#### Callbacks run as part of an async algorithm

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


### Events

Events are a single API that is used for a great number of things, including
cases which have a clear JavaScript-originating cause, and cases which the
callback is almost always triggered as a consequence of user interaction.
Excluding promises, events are the most common way for web APIs to asynchronously
call into user code.

AsyncContext propagation across event-based APIs needs to balance different needs:
1. it should propagate the context where needed by tracing libraries to be able
   to trace across common code patterns, providing useful information to web
   developers about performance characteristics and possible problems of their
   applications;
2. it should be predictable, so that developers can build an intuition of how propagation
   works without having to learn it on a per-API basis;
3. it should not be eccesively complex to implement in web engines, for example requiring
   to analyze reachability of JavaScript objects across processes or by causing
   engines to unnecessarily hold onto objects for too long.

#### Events by dispatch timing

Event dispatches can be split in three categories:
- **Synchronous dispatches**, where the event dispatch happens synchronously
  when a web API is called.
- **Asynchronous dispatches**, where the event originates from JS calling into
  some web API, but the dispatch happens at a later point.
- **Externally-caused dispatches**, where the event is triggered by browser or
  user actions, or by cross-agent JS, with no involvement from JS code in the
  same agent.

##### Synchronous event dispatches

`EventTarget` by itself is a fully synchronous API. At some point some other API will want to dispatch an event,
and that will synchronously fire the corresponding event listeners. Some examples are the `.dispatchEvent` method
itself, but also methods like `HTMLElement.click()`, or setting `location.hash`.

Like for all other synchronous APIs that end up calling a user-provided function, we propose that it does
not interact with `AsyncContext` at all. Effectively, the context that will be active when the event listeners
are called is the same as the one active when the event is dispatched, as it would happen if somebody was to
set a global variable before dispatching the event and unsetting it afterwards.

More specifically:
- `.addEventListener` does _not_ take any snapshot, it just stores the callback as it's already doing today;
- `.dispatchEvent` does _not_ read or set the current active context.

Consumers that want to dispatch events in a different context can do so by running `someVar.run(value, () => target.dispatchEvent(e))` or `someSnapshot.run(() => target.dispatchEvent(e))`. The spec-internal algorithm to dispatch an event _might_ take an optional "context" parameter, if it's editorially simpler than having some callers do the manual `.run()` dance. It's however semantically equivalent to the above.

##### Externally-caused event dispatches

These events are triggered either by user action, or by causes external to the current JS agent. Some examples are:
- a user clicks on a button, causing a `click` event to be dispatched on it
- a worker `postMessage`s to the main thread, causing a `message` event to be dispatched on the `Worker` object
- the browser loses access to the network, causing an `offline` event to be dispatched on the `window` object

JavaScript code reacting to these events is not running as a clear consequence of some other JavaScript code in the same agent: it is
usually starting a new "task", or a new "trace", with no causal/parent task. All these events should be dispatched in
an empty AsyncContext.

##### Asynchronous event dispatches

These events are dispatched as a direct consequence of some JavaScript API call, but asynchronously. Usually they involve
waiting on some I/O operation to progress or complete.  We can further divide them in two cathegories:
- events dispatched on an object representing/holding one task, that has both utilities to create the task and to signal updates about it (e.g. `XMLHttpRequest`)
- events dispatched due to web APIs that are separate from the object that the events are dispatched on (e.g. `animationstart` fired on an `HTMLElement` as a consequence of updating a CSS class somewhere in the DOM).

###### Objects responsible for one task

Asynchronous APIs that fire events as a result of some method/setter call, for which the event is fired either (a) on the object returned by the method (either directly or wrapped in a promise), or (b) if the instance is not a singleton on the object whose method was called on, would propagate the context.

This includes all the events that are conceptually similar to promise (e.g. `load`, except for the global page load), for which it's most important that the context is propagated. It excludes events dispatched on singletons, such as `window`/`document`/`document.fonts`, as these singletons do not represent a task but are simply a place where to listen for global events.

The context would be stored on this "holder object" when the task starts, and used to dispatch events that represent progress/completion of the task. It would be cleared when the task is known to be completed, since further events are known to not be fired anymore (unless the task is re-started, in which case it would capture a new context). Events "emulated" through `.dispatchEvent` would not use this context, as it's the _caller_ of the event-dispatching logic that is responsible for setting it up.

An example of an API where this is possible is `XMLHttpRequest`, which if implemented in JavaScript could look like this:

<details>
<summary>Code</summary>

```javascript
const { send, addEventListener } = XMLHttpRequest.prototype;
XMLHttpRequest.prototype.send = function () {
  const ctx = this.__sendContext = new AsyncContext.Snapshot();

  { // Clean up the captured context when it's not needed anymore
    this.__sendContextAC?.abort();
    const ac = this.__sendContextAC = new AbortController();
    ac.signal.addEventListener("abort", () => {
      if (this.__sendContext === ctx) this.__sendContext = null;
      if (this.__sendContextAC === ac) this.__sendContextAC = null;
    }, { once: true });
    addEventListener.call(this, "readystatechange", (e) => {
      if (e.isTrusted && this.readyState === 4) {
        // Abort _after_ running the other event listeners
        setTimeout(() => ac.abort(), 0);
      }
    }, { signal: ac.signal });
  }

  return send.apply(this, arguments);
};
XMLHttpRequest.prototype.addEventListener = function (name, handler, options) {
  const self = this;

  // This actually also needs to keep a reference to the wrapper in a WeakMap,
  // and patch .removeEventListener to properly remove the wrapped handler.
  // It also needs to support the case when handler is an object.
  addEventListener.call(this, name, function (event) {
    // We only want to propagate the context for events actually dispatched
    // by the browser as a consequence of .send()
    if (event.isTrusted) {
      switch (name) {
        case "progress":
        case "loadstart":
        case "loadend":
        case "readystatechange":
        case "load":
        case "error":
        case "timeout":
          if (self.__sendContext)
            return self.__sendContext.run(() => handler.apply(this, arguments));
          break;
      }
    }
    return handler.apply(this, arguments);
  }, options);
};

// It also needs to patch the .on* setters, as well as .abort() and the abort event
```

</details>

A native implementation would be simpler, as it would set the context before dispatching an event inside XHR's logic rather than inside EventTarget's logic, but it still has the complexity of keeping the context around and knowing when it can be cleaned up.

One relevant entry in this category is DOM elements that represent some sort of resource, such as `<script>` or `<img>` elements. Context propagation is important for tracing libraries to be able to properly track resource loading, and incredibly complex to do in JavaScript due to the complexity of the DOM. Consider an example with a batch DOM mutation:
```javascript
function updateDOM(el) {
  el.innerHTML = `
    <img id="img1" src="image1.png">
    <img id="img2" src="image2.png">
  `;
}

function run() {
  /* contextID: 1 */
  updateDOM(someElement);
}

function listen() { // called after run()
  someElement.querySelector("#img1").addEventListener("load", () => {
    // this needs "contextID: 1"
  });
}
```

When creating/updating these DOM objects (which happens synchronously), the browser will need to read the pointer to the AsyncContext map from the current agent, and store it on those objects. Note that all objects created/updated from a single mutation will reference the same AsyncContext. Chrome implements similar capturing for task attribution, and has not found any relevant performance degradation.

In case of event propagation through the DOM (capturing and bubbling), all event handlers run in the context captured by the target element, as the event dispatching process would be to first set the appropriate context, and then run all the existing event machinery.

###### Events dispatched on separate objects

Some async APIs allow starting tasks that then will cause events on _other_ objects to be fired. Some examples are:
- a `DOMTokenList.add()` call to add a CSS class to an HTML element that eventually causes an `animationstart` event to be fired (potentially even on a different element than the one the `DOMTokenList` originally came from);
- a `fetch()` call that causes a `securitypolicyviolation` event to be fired on the global object.
- the various APIs that dispatch events across threads, including `CookieStore`, `IndexedDB` and `LocalStorage`.

We propose that these async event dispatches never propagate the AsyncContext.

Propagation for these cases is generally impossible to do in userland. However, it is also significantly complex to implement natively, as it requres carrying around the pointer to the context through the various internal steps that lead to the event being fired, rather than just storing it somewhere.

The usefulness of propagating the current trace/context in these cases varies a lot. Code that runs as a consequence of these events being fired is not generally a continuation of the task that caused them to be fired, and they would start a new trace. There are two main exceptions for which it would be useful to propagate the context across separate objects:
- `MessagePort`'s `postMessage` to the corresponding `message` event, which is a common way to implement `setImmediate`-like behavior. All the libraries that use this pattern to perform scheduling will not work by default with `AsyncContext`, unless they are updated to propagate it manually. The manual propagation is not too complex (it's a single call to `AsyncContext.Snapshot.run()`), but it will require all those libraries to update.
- `ErrorEvent`/`PromiseRejectionEvent` (and `SecurityPolicyViolationEvent`, probably) events fired on the global object. These events are often used to log errors happening in the application, and having the context available would be useful to tracing libraries. However, it is not necessarily useful that the context that the errors where caused in is the one _active_ when running those event handlers, as usually the logging code that will need to read that context is running directly in the event callback and is not a detached consequence of it. For consistency, these events should thus still not propagate the context by default, but they can expose the `AsyncContext.Snapshot` as a special property on the event object (e.g. `event.rejectionContext`).

#### Summary of event propagation rules

1. APIs that dispatch events synchronously do not change the currently active async context, like all other synchronous APIs.
2. Events fired due to JS-external causes, such as user interaction, run the event handlers in an empty context.
3. Asynchronous APIs that fire events as a result of some method/setter call, for which the event is fired either (a) on the object returned by the method (either directly or wrapped in a promise), or (b) if the instance is not a singleton on the object whose method was called on, propagate the context.
4. Asynchronous APIs that dispatch events on separate objects do not propagate the context (and run the event handlers in an empty one), regardless of whether they are cross-thread or same-thread.
5. Some special error-reporting events (`ErrorEvent`, `PromiseRejectionEvent`, `SecurityPolicyViolationEvent`) fall under (3), but will have an extra property on the event object exposing the context of the code that caused the error.

<details>
<summary>These tables are a (currently incomplete) list of cases that fall in the various categories</summary>

The following async APIs propagate the context into the events they dispatch:

| Class    | Method (task start) | event | Comments
| -------- | -------- | -------- | -------- |
| `BackgroundFetchRegistration` | returned by `backgroundFetch.fetch()`     | `progress`     |
| `XMLHttpRequest` | `.send()` | `error`, `load`, `loadend`, `loadstart`, `progress`, `readystatechange`, `timeout` | `loadend` _can_ be triggered synchronously by `.abort()` |
| `HTMLImageElement` | `.src` setter | `load` | This image is technically loaded not due to setting `.src`, but due to polling for the `.src` attribute in its processing model (https://html.spec.whatwg.org/#images-processing-model)
| `DBOpenRequest` | returned by `indexedDB.open()` | `success` |
| `Element` | `.requestFullscreen()` | `fullscreenchange`, `fullscreenerror` | This method _also_ returns a promise, but the triggered events are used by ancestors thanks to propagation |


These will not because they are on non-`globalThis` singleton instances (TODO: Can we make this propagate, and only keep the non-propagation `globalThis`?):
| Class    | Method (task start) | event | comments |
| -------- | -------- | -------- | -------- |
| `FontFaceSet` | `.load()` | `loading`, `loadingdone`, `loadingerror` | `document.fonts.load()` returns a promise, so the "logical continuation" of the call would happen in the promise's `.then` handler
| `CookieStore` | `.set()` | `change` | Can also be triggered cross-thread. `.set()` returns a promise.
| `DocumentPictureInPicture` | `.requestWindow()` | `enter` | `.requestWindow()` also returns a promise
| ...

These will not propagate because they fire events on separate objects:
| Class    | Method (task start) | target | events | comments |
| -------- | -------- | -------- | -------- | -------- |
| `FontFace` | constructor | `document.fonts` | `loading`, `loadingdone`, `loadingerror` | `FontFace` object have a promise `.ready` property, that would be used by code for the "logical continuation" of waiting for the font to be ready
| `FontFace` | `.load()` | `document.fonts` | `loading`, `loadingdone`, `loadingerror` | (as above)
| `IDBFactory` | `.open()` | `DBOpenRequest` returned by a separate `.open()` call | `upgradeneeded` | Often cross-thread
| `MessagePort` | `.postMessage()` | The (different) connected `MessagePort` object | `message` | Often cross-thread
| `BroadcastChannel` | `.postMessage()` | All other `BroadcastChannel` objects with the same name | `message` | Often cross-thread
| `CSSStylesProperties` | `.contentVisibility` setter | `Element` whose styles belong to | `contentvisibilityautostatechange` | From a tracing perspective it would be nice for this to propagate
| ...

These API synchronusly dispatch events, so the event handlers see the context from the code that caused them without the web API expicitly handling it:
| Class    | Method (task start) | event | Comments
| -------- | -------- | -------- | -------- |
| `AbortController` | `.abort()` | `abort` on the connected `AbortSignal`  |
| `XMLHttpReqest` | `.abort()` | `abort` |
| `Element` | `.click()` | `click` | Can also be triggered by user interaction, in which case it would have an empty active context
| ...

</details>

#### Previously discarded approaches for events

Propagation of AsyncContext through events has been redesigned across multiple iterations.
This section documents some of the previously considered approaches that have been discarded.

##### Capture the context when the event listener is registered

The first proposed solution was to capture the context at the time `.addEventListener` is called,
effectively as in the following manual propagation:

```js
element.addEventListener("load", AsyncContext.Snapshot.wrap((event) => {
  // ...
}));
```

This approach was discarded because:
- it is sub-optimal for tracing, since it does not give any information about what caused the event to run
- it can cause significant memory footprints, since there is no clear point in time when the captured snapshot can be cleaned up unless the whole `EventTarget` is garbage collected
- for developers that do need it, it's trivial to manually wrap the callback as in the example above

##### Always propagate from APIs that dispatch events

Another approach that was considered is to always propagate the context from the API that caused the event to be eventually triggered, falling back to the empty context for externally-caused events. This is what would have been the most useful for web developers, as it maximizes context propagation giving thus the best results when tracing, including in rarely relevant edge cases.

This approach was however discarded because of the significant complexity to implement it in web engines, which would have risked significantly outweighing its benefits.

##### Propagate only for a fixed set of events

A simpler-to-implement approach than "always propagate from where the event was caused" was to only propagate for a predefined set of events, that we know from user feedback being especially important. This included all the `load`/`error` events for resource loading, `unhandleredrejection`/`error` events, `MessagePort`'s `message`, and a few others. It is likely that we would have been able to then expand the list of events over time.

It was eventually discarded because:
- while we expect expanding that list over time to be generally safe, we cannot rule out backward compatibility issues that would prevent one event to start propagating more;
- it would have required developers to basically memorize a list of events that behave one specific way, without being able to build a general intuition of how async context propagation for events works.

##### Opt-in propagation from APIs that dispatch events

We also considered to not propagate by default, but allowing developers to opt-in with an option (such as to call `xhr.send({ propagateAsyncContext: true })` to make `XMLHttpRequest.send` propagate the context to the various events it causes).

This allows a safer incremental approach, as:
- it guarantees that we can extend propagation to more APIs safely, as it's always opt-in;
- an opt-in is more discoverable for developers than knowing whether an API is implicitly propagating or not.

We considered two ways that the opt-in toggle could be exposed:
1. on a per-function-call basis (e.g. `xhr.send({ propagateAsyncContext: true })`). This goes against the tracing goal of letting the tracing library taking care of context propagation, without requiring userland code to be modified (the tracing library would have to patch all built-ins to enable these options for their users).
2. on a global basis, maybe with a manifest file that lists which API would propagate. This would have global coordination problems, where different libraries might expect different kinds of propagation, as well as being generally more complex to deploy in large applications with multiple parts owned by different teams.

### Status change listener callbacks

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

#### Worklets

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

#### Custom elements

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

### Observers

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
> is created, and use it to run the callback. This has been removed due to memory footprint concerns.

In some cases it might be useful to expose the causal context for individual
observations, by exposing an `AsyncContext.Snapshot` property on the observation
record. This should be the case for `PerformanceObserver`, where
`PerformanceEntry` would expose the snapshot as a `resourceContext` property. This
is not included as part of this initial proposed version, as new properties can
easily be added as follow-ups in the future.

### Stream underlying APIs

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

### Module evaluation

When you import a JS module multiple times, it will only be fetched and
evaluated once. Since module evaluation should not be racy (i.e. it should not
depend on the order of various imports), the context should be reset so that
module evaluation always runs with the empty AsyncContext snapshot.

### Security Considerations

The goal of the AsyncContext web integration is to propagate context inside
a same-origin web page, and not to leak information across origins or agents.

The propagation must not implicitly serialize and deserialize context values
across agents, and no round-trip propagation. The propagation must not involve
code execution in other agents.

#### Cross-document navigation

When a cross-document navigation happens, even if it is same-origin, the context
will be reset such that document load and tasks that directly flow from it
(including execution of classic scripts found during parsing) run with the
empty AsyncContext snapshot, which will be an empty mapping (i.e. every
`AsyncContext.Variable` will be set to its initial value).

#### Cross-origin iframes

Cross-origin API calls do not propagate the context from one origin to the other,
as if they were happening in different agents/threads. This is also true for APIs
that synchronously run cross-origin code, such as calling `.focus()` on a
cross-origin iframe's window: the context is explicitly reset to the top-level one.

See [whatwg/html#3506](https://github.com/whatwg/html/issues/3506) for related
discussion about `focus()`'s behavior on cross-origin iframes.

## Editorial aspects of AsyncContext integration in web specifications

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

### Using AsyncContext from web specs

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
