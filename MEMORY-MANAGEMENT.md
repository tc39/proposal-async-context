# Memory management in AsyncContext

A context (sometimes called a snapshot; or in the spec, "a List of Async Context
Mapping Records") is an immutable map from `AsyncContext.Variable` instances to
arbitrary JS values (or possibly also spec-internal values; see "Using
AsyncContext from web specs" in the main web integration document). Each agent
will have a `[[AsyncContextMapping]]` field which is a context, which we will
sometimes refer to as "the current context".

Given a variable `asyncVar`, which is an instance of `AsyncContext.Variable`,
running `asyncVar.run(value, callback)` will:
    1. Create a new context which is a copy of the current context, except that
       `asyncVar` maps to `value`.
    2. Set that new context as the current context.
    2. Run the callback.
    3. Restore the current context to the value it had before step 2.

By itself, this would only allow keeping memory alive implicitly within a call
stack, which would be no different from local variables from a stack frame being
kept alive while a function is running.

However, the thing that makes AsyncContext AsyncContext is that the context can
be propagated across asynchronous operations, which eventually cause tasks or
microtasks to be enqueued. Some of these operations are defined in TC39, such as
`Promise.prototype.then` and `await`, but most of them are defined in web specs,
such as `setTimeout` and the many other APIs listed above.

For many of these async operations (such as `setTimeout` and `.then`), a
callback is run once or multiple times in a task or microtask. In those cases,
the operation can be seen as keeping a strong reference to the callback, and it
will also keep a strong reference to the context that was current at the time
that the API was called to start that operation. When the operation is finished,
that reference will be removed.

For events, we do not store the context in which `addEventListener` is
called (though see the next paragraph on the fallback context). Instead, the
context is propagated from the web API that caused it, if any. For APIs that
cause events to fire asynchronously (e.g. XHR), this would involve storing a
reference to the context when the API is called (e.g. `xhr.send()`), and keeping
it alive until no events can be fired anymore from that asynchronous operation
(e.g. until the XHR request finishes, errors out or is aborted).

`addEventListener`, however, would need changes with the fallback context
proposal[^1]. The initial version of this proposal would allow
`addEventListener` to associate a context with the listener (only if the current
context contains a key that is set in a call to the fallback context API).
However, rather than storing a whole context, a newer iteration of this proposal
(described in https://github.com/tc39/proposal-async-context/issues/107#issuecomment-2659298381)
would let the API only store the values of one or more `AsyncContext.Variable`s
that would need to be passed to the API. This means that in practice, this
context which would be associated to `addEventListener` would only reference one
or a few objects.

[^1]: This proposal isn't described in any depth in the main web integration
document because the details are still being worked out. See
<https://github.com/tc39/proposal-async-context/issues/107>.

The web integration document says that observers (such as MutationObserver,
IntersectionObserver...) would use the registration context for their callbacks;
which means when the observer is constructed, it would store a reference to the
current context, which would never be released while the observer is alive.
However, it seems like it might be possible to change this behavior so the
context is not stored at all for observers; instead, the callbacks would be
called with the empty context.

Although this document and the web integration one describe the context
propagations that must happen due to the browser and JS engine's involvement,
it is also important to have in mind how authors might propagate contexts
implicitly. For example, from the browser's perspective, `requestAnimationFrame`
only keeps the context referenced until the rAF callback is called. However, the
context is active when the callback is called, and the callback is likely to
call `requestAnimationFrame` again, continuing to propagate the same context.

## The context as a weak map

The AsyncContext proposal purposefully does not allow JS code to have a list of
the entries, or of the `AsyncContext.Variable` keys, in a context. This is so to
keep encapsulation, but it has the side effect that it allows implementing the
context as a weak map.

If the context was implemented as a weak map, then the `AsyncContext.Variable`
keys would be weak references, and an entry in the map would be deleted if the
key becomes unreachable.

In most uses of AsyncContext, we don't expect `AsyncContext.Variable`s to become
unreachable while the realm in which it was created remains alive. This is
because most uses would store it in a (JavaScript) variable at the top level of
a script or module.

However, we do expect a weak map implementation to be useful in cases where a
cross-realm interaction results in `AsyncContext.Variable` keys and object
values of different realms in the same context, since otherwise that could
result in leaking the realm. After all, we expect that in the general case
`AsyncContext.Variable` keys from a realm would map to values that only contain
objects from the same realm. So if the only remaining references to a realm are
from entries in the context which have keys in the realm, the keys will be
unreachable, and so the entries will be deleted.

The proposed JS spec for AsyncContext does not explicitly mandate that the
context must be implemented as a weak map, but that is a possible
implementation. However, garbage collecting weak maps takes a performance hit,
and some folks have previously argued against it for that reason. If you think
it's important that the context is a weak map, please let us, as well as the
various JS engine implementers, know about it.