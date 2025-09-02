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
   `asyncVar` maps to `value`. The reference to `value` in the context is
   strongly held (not a weak reference), but see the
   [weak map section](#weak-maps) below.
2. Set that new context as the current context.
3. Run the callback.
4. Restore the current context to the value it had before step 2.

By itself, this would only allow keeping memory alive implicitly within a call
stack, which would be no different from local variables from a stack frame being
kept alive while a function is running.

However, the thing that makes AsyncContext AsyncContext is that the context can
be propagated across asynchronous operations, which eventually cause tasks or
microtasks to be enqueued. Some of these operations are defined in ECMA-262,
such as `Promise.prototype.then` and `await`, but most of them are defined in
web specs, such as `setTimeout` and the many other APIs listed above.

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

`addEventListener`, however, would need changes if we add the
`EventTarget.captureFallbackContext` API[^1]. With it, the context in which the
passed callback is called also stores the current values of the given
`AsyncContext.Variable`s at the time that `captureFallbackContext` is called,
and any calls to `addEventListener` in that context *will* store those values
alongside the event listener. This will likely leak the values associated to
those variables, and we will need outreach to web platform educators to make
sure that authors understand this, but it's the best solution we've found to
cover one of the goals of this proposal, since the other options we've
considered would cause a lot more leaks.

[^1]: This API isn't described in any depth in the main web integration document
because the details are still being worked out. See
<https://github.com/tc39/proposal-async-context/issues/107>. Note that this
document describes the version described in
[this comment](https://github.com/tc39/proposal-async-context/issues/107#issuecomment-2659298381),
rather than the one in the OP, which would need storing the whole current
context.

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
only keeps the context referenced until the rAF callback is called. However, if
the callback recursively calls `requestAnimationFrame`, which is often the case,
the context is propagated with the callback in the recursion.

## The context as a weak map

Values associated to an `AsyncContext.Variable` must be strongly held (not weak
references) because you can do `asyncVar.get()` inside that context and get the
associated value, even if there are no other references to it.

However, the AsyncContext proposal purposefully gives JS code no way to get a
list of the entries stored in an async context map. This is
done to maintain encapsulation, but it also has the side effect that it allows
implementing the context as a weak map.

If an `AsyncContext.Variable` used as a key in the context is otherwise unreachable,
then there is no way for any JS code to read the corresponding async context entry
at any future time. At that point, that whole entry in the context map (both the key
and the value), could be deleted. This would be implementing the context as a weak
map (see the JS [`WeakMap`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakMap)
built-in).

In most uses of AsyncContext, we don't expect that `AsyncContext.Variable`s
could become unreachable (i.e. GC-able) while the async context maps that capture
stay reachable. This is because most uses would store the `AsyncContext.Variable`
object in a (JavaScript) variable at the top level of a script or module, so any
exported functions in the script/module will have it in its scope, and will keep
it alive.

However, we do expect a weak map implementation to be useful in cases where a
cross-realm interaction results in capturing `AsyncContext.Variable` keys from a different realm. This capturing happens implicitly through cross-realm function
calls, and we wouldn't want to accidentally keep a whole realm alive.

The proposed JS spec for AsyncContext does not explicitly mandate that the
context must be implemented as a weak map, but that is a possible
implementation. However, we are aware that garbage collecting weak maps comes at a
performance cost.

We expect that there will be two "kinds" of async context maps:
- a lot of very short-lived ones, used by frameworks during the rendering process.
- a few long-lived ones, used to trace long-running tasks

We also expect that, while there can be a lot of async context maps, they will all contain a very limited number of entries (a single-digit amount in most cases).

For this reason, after consulting with experts in the field, the champions'
recommendation is to implement a hybrid approach. Async context maps should initially
be considered to held their entries strongly, and then transition to be weak after a
while. Deciding exactly what "after a while" means will need in-the-field
experimentation, but some potential approaches are:
- async context maps that survive one major CG cycle get marked as weak
  - or, async context maps that survive X major GC cycles
- async context maps are marked as weak after a set amount of time
- for platform that have "young objects" and "old objects" memory spaces, async context maps could become weak once they get moved to the old space.

The goal of these approaches is that when creating async context maps that live
shorter than a framework's rendering cycle, they would never transition to be
weak before that the whole map is garbage collected.

Given that weak context maps are not directly exposed to JavaScript, switching between
weak and strong only requires flipping a bit somewhere that the garbage collector
references graph traversal logic can check.
