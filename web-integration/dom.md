# AsyncContext propagation in the DOM specification

This document describes the changes needed in the DOM specification to apply the [event propagation principles](../WEB-INTEGRATION.md#summary-of-event-propagation-rules). Most of DOM is synchronous, and thus transparent to AsyncContext: these changes are mostly infrastructure used by other specifications, such as [HTML](./html__events.md).

TL;DR:
- dispatching an event does not change the current context, and event listeners run in the context active when the event is dispatched
- DOM provides the infrastructure that other specifications use to fire events in a captured context
- `AbortSignal.timeout()` propagates the context to the `abort` event it fires
- mutation observers and `slotchange` events run in the empty context

## DOM spec sections

### 2 - Events

[Dispatching](https://dom.spec.whatwg.org/#concept-event-dispatch) an event, either through `.dispatchEvent()` or from a specification, does not capture nor change the current context. `.addEventListener()` does not capture the context either.

[Firing an event](https://dom.spec.whatwg.org/#concept-event-fire) takes an optional AsyncContext, in which the event is dispatched. Specifications capture the context when the action that causes the event happens, and pass it when later firing the event, as described in the [HTML events document](./html__events.md).

For the common case of an object whose method or constructor starts an async operation that fires events on that same object (e.g. `XMLHttpRequest`'s `.send()`, or the [`EventSource()` constructor](./html__events.md#92---server-sent-events)), DOM will define a `[PropagatesAsyncContextToEvents]` WebIDL extended attribute, which takes a list of event types. When a method or constructor annotated with it is called, the user agent must:
- synchronously capture the current AsyncContext, and store it on the object for each of the listed event types
- use that context to fire events of those types on the object, when they are fired with no JavaScript on the stack (events dispatched with `.dispatchEvent()`, or fired synchronously, keep using the current context)

Specifications can manually clear the stored context once the operation cannot fire those events anymore, so that it is not kept alive for the lifetime of the object.

Objects created by a method rather than by their own constructor (e.g. `IDBOpenDBRequest`, returned by `indexedDB.open()`) can capture the context with a similar mechanism, using an algorithm version of that extended attribute.

> [!NOTE]
> Most async operations in HTML are not started by a method call or a constructor, but by setting an attribute or by inserting an element in the document. In those cases HTML captures the context explicitly, rather than using the extended attribute.
> 
> Whether this is useful enough for other specs to be justified is still to be determined, but it has at least the documentation advantage of making it clear when something does propagate the context. It's similar to `[CEReactions]`, which doesn't mark _all_ places that can schedule reactions but many of them.

### 3 - Aborting ongoing activities

`AbortController`'s `.abort()` synchronously aborts its signal, as well as the signals that depend on it through [`AbortSignal.any()`](https://dom.spec.whatwg.org/#dom-abortsignal-any), so their abort algorithms and `abort` events run in the context of the `.abort()` call.

When running [`AbortSignal.timeout()`](https://dom.spec.whatwg.org/#dom-abortsignal-timeout), the user agent must:
- synchronously capture the current AsyncContext
- use that context to [signal abort](https://dom.spec.whatwg.org/#abortsignal-signal-abort) on the returned signal when the timeout expires, so that both its abort algorithms and the `abort` events fired on it and on its dependent signals run in that context

This follows from the [event propagation principles](../WEB-INTEGRATION.md#summary-of-event-propagation-rules) (`AbortSignal.timeout()` creates an `EventTarget` object and schedules a timer that will eventually fire an event on it), and it matches the propagation users would get if they were to re-implement it using `setTimeout`+`AbortController.abort()`.
### 4.3 - Mutation observers

[`MutationObserver`](https://dom.spec.whatwg.org/#interface-mutationobserver) callbacks are batched, and multiple DOM mutations coming from different async contexts might be reported as multiple `MutationRecord`s with a single callback call. As there is no primary context among them, `MutationObserver` callbacks run in the empty context. This follows from the general [propagation principle for observers](../WEB-INTEGRATION.md#observers).

> [!TIP]
> If there is a need, in the future we could expose those various contexts as a `.mutationContext` field on the various `MutationRecord` objects, holding `AsyncContext.Snapshot` instances.

Features built on top of `MutationObserver` , such as the `slotchange` event, inherit its semantics.
### 4.2.3, 4.9 - Custom elements

The [mutation algorithms](https://dom.spec.whatwg.org/#mutation-algorithms), [creating an element](https://dom.spec.whatwg.org/#concept-create-element), and attribute changes enqueue custom element reactions synchronously, as part of the action that causes them. The context is captured by HTML when the reaction is enqueued, as described in the [HTML custom elements document](./html__custom-elements.md). No changes are needed in DOM.
