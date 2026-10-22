# AsyncContext propagation to custom element reactions in the HTML specification

This document describes the details of how AsyncContext is propagated to custom element lifecycle callbacks.

TL;DR:
- constructors and lifecycle callbacks run in the context of the action that caused them, like events fired in reaction to DOM changes
- when they are caused by user interaction or by the user agent itself, they run in the empty context
- the context active when the custom element was defined with `customElements.define()` is never used

## Custom element reactions

Custom element constructors and lifecycle callbacks are not called directly by the DOM operations that trigger them. Instead, those operations enqueue a [custom element reaction](https://html.spec.whatwg.org/#custom-element-reactions) on the element (an *upgrade reaction*, which will run the constructor, or a *callback reaction*, which will call a lifecycle callback), and add the element to an *element queue*. The reactions are later run by [invoking custom element reactions](https://html.spec.whatwg.org/#invoke-custom-element-reactions) for that queue.

There are two kinds of element queues:

- Web APIs annotated with [`[CEReactions]`](https://html.spec.whatwg.org/#cereactions) (e.g. `.append()`, `.remove()`, `.setAttribute()`, `.innerHTML`, `customElements.define()`) push a new element queue when called, and _synchronously_ invoke its reactions right before returning to the caller. The HTML parser does the same when [creating](https://html.spec.whatwg.org/#create-an-element-for-the-token) and [inserting](https://html.spec.whatwg.org/#insert-an-element-at-the-adjusted-insertion-location) elements.
- DOM changes that happen when no element queue has been pushed, for example due to user editing, due to the user agent, or due to JavaScript calling a web API *not* annotated with `[CEReactions]` (e.g. `.click()`), add the element to the [backup element queue](https://html.spec.whatwg.org/#backup-element-queue). Its reactions are invoked in a microtask, which runs at the same time the reactions added by different callers.

Reactions are stored on the element, and invoking the reactions for an element queue runs, for each element in it, all the reactions pending on that element, regardless of which JS API enqueued them.

For `[CEReactions]` we have a stack of queues: if while processing the top of the stack something else schedules new `[CEReactions]`, they will not interfere with each other.
- If we're processing A in a queue containing A,B,C and we trigger a `[CEReactions]` on D and E, we'll process D and E first, and then once we go back to the previous queue we'll process B and C.
- If we're processing A in a queue containing A,B,C and we trigger a `[CEReactions]` on B and D, we'll process B and D first; then we go back to the original queue, but B has no more reactions (they have been already processed) so we only run those for D.

> [!NOTE]
> A concrete example for that second case is:
> ```js
> v.run("y", () => parent.append(e1, e2, e3)); // schedules connectedCallback for e1, e2, and e3
>
> // in e1's connected callback:
> v.run("x", () => e2.setAttribute("foo", "1")); // schedules attributeChangedCallback for e2
> ```
>
> At the end of the `.setAttribute()` call the current queue of elements to process is `[e2]`, so
> we run all its reactions: both `connectedCallback` and `attributeChangedCallback`. When we then finish
> running `e1`'s `connectedCallback`, we go back to the previous queue (`[e1, e2, e3]`), but `e2` has no
> more reactions to run, so we only run `e3`'s `connectedCallback`.

## Propagation model

When using `[CEReactions]`, most of the time they would run synchronously with the correct context from what caused them. However, given that this is effectively a schedule that can reorder tasks and run them from different callers (e.g. in the A,B,C + B,D example above) we need to take AsyncContext snapshots.

When a custom element reaction is enqueued, either by [enqueuing a custom element callback reaction](https://html.spec.whatwg.org/#enqueue-a-custom-element-callback-reaction) or by [enqueuing a custom element upgrade reaction](https://html.spec.whatwg.org/#enqueue-a-custom-element-upgrade-reaction), the user agent must:

- synchronously capture the current AsyncContext, and store it on the reaction
- use that context to run the constructor or the lifecycle callback when [invoking the reaction](https://html.spec.whatwg.org/#invoke-custom-element-reactions), including when reporting an exception thrown by it

As a consequence:
- reactions caused by a call to a `[CEReactions]` web API run in the context of that call, the same as if the callback had been called synchronously
- reactions caused by JavaScript calling a web API without `[CEReactions]` run in the context of that call, even though they are invoked later in a microtask
- reactions caused by user interaction or by the user agent run in the empty context, since they are enqueued with no JavaScript on the stack

> [!IMPORTANT]
> The context must be captured per reaction, and not per element queue. Capturing it once per queue (or only for the backup element queue) would attribute some reactions to the wrong context:
>
> - The backup element queue is processed in a single microtask, shared by all the reactions enqueued until it runs:
>
>   ```js
>   v.run("a", () => summaryA.click());
>   v.run("b", () => summaryB.click());
>   // the two attributeChangedCallback calls must log "a" and "b", not "a" twice
>   ```
> - An element's pending reactions are all run by whichever element queue reaches the element first:
>   ```js
>   class MyElement extends HTMLElement {
>     static observedAttributes = ["foo"];
>     attributeChangedCallback() {}
>     connectedCallback() {
>       if (this.id === "e1") v.run("x", () => e2.setAttribute("foo", "1"));
>       else console.log(v.get());
>     }
>    }
>    v.run("y", () => document.body.append(e1, e2));
>   // e2's connectedCallback, enqueued by .append(), must log "y" even though it is
>   // run by the element queue of the .setAttribute() call
>   ```
> - Reactions enqueued by JavaScript code running *inside* a `[CEReactions]` web API (e.g. `reset` event listeners during `form.reset()`, or a constructor during `document.createElement()`) are added to that API's element queue, and must still run in the context they were enqueued in, rather than in the context of the outer call.

## Callback by callback
### Constructors and upgrades

Constructors that run synchronously, either because they are called directly with `new` or because a custom element is created by `document.createElement()`, are transparent to AsyncContext. The same is true for constructors run by the HTML parser: they run in the empty context when parsing network data, and in the context of the `document.write()` call when parsing data written by it.

Other constructors are run by [upgrading an element](https://html.spec.whatwg.org/#concept-upgrade-an-element), which uses the context captured when the upgrade reaction was enqueued, which is the context of:
- the call to [`customElements.define()`](https://html.spec.whatwg.org/#dom-customelementregistry-define), for elements already in the document when their definition is registered
- the call to [`customElements.upgrade()`](https://html.spec.whatwg.org/#dom-customelementregistry-upgrade) or [`customElements.initialize()`](https://html.spec.whatwg.org/#dom-customelementregistry-initialize)
- the DOM operation that inserted the element in a document, for elements whose definition was registered after they were created
- the DOM operation that created the element, such as `.cloneNode()` or setting `.innerHTML`

Upgrading an element can itself enqueue `attributeChangedCallback` (once for each existing observed attribute), `connectedCallback`, `formAssociatedCallback`, and `formDisabledCallback` reactions. Since these are enqueued while running the upgrade, they run in the same context as the constructor.
### `connectedCallback`, `disconnectedCallback`, `connectedMoveCallback`, `adoptedCallback`

These callbacks run in the context of the DOM operation that inserted, removed, moved or adopted the element. They run in the empty context when the operation is caused by user interaction (e.g. the user deleting the element while editing a `contenteditable` element) or by the HTML parser while parsing network data.

When a custom element doesn't define `connectedMoveCallback`, moving it with `.moveBefore()` calls `disconnectedCallback` and `connectedCallback`: they both run in the context of the `.moveBefore()` call.
### `attributeChangedCallback`

This callback runs in the context of the action that changed the attribute: a call to `.setAttribute()` or a similar method, setting an IDL attribute that reflects it, or calling a method that changes it as a side effect (e.g. `dialog.close()` removing `open`).

This also applies when the attribute is changed by a web API that is not annotated with `[CEReactions]`. For example, calling `.click()` on the `summary` of a [customized built-in](https://html.spec.whatwg.org/#customized-built-in-element) `details` element toggles its `open` attribute, and `attributeChangedCallback` runs in the context of the `.click()` call. This is the same context used by the [`toggle` event](./html__events.md#4111---the-details-element) fired as a consequence of the same attribute change, so effectively there is only one propagation happening in the spec text.

When the attribute is changed due to user interaction (e.g. the user toggling a `details` element, or [find-in-page](https://html.spec.whatwg.org/#find-in-page) removing `hidden="until-found"`), the callback runs in the empty context.
### Form-associated callbacks

`formAssociatedCallback` runs in the context of the action that caused the element's [form owner to be reset](https://html.spec.whatwg.org/#reset-the-form-owner) to a different form, for example inserting it in a `form` element or changing its `form` attribute.

`formDisabledCallback` runs in the context of the action that changed the element's disabled state, for example setting its `disabled` attribute or the `disabled` attribute of an ancestor `fieldset`.

> [!NOTE]
> **QUESTION:** Outside of upgrades, the HTML specification only describes when these two callbacks are called in prose, without saying when exactly their reactions are enqueued. Do implementations enqueue them synchronously as part of the DOM change?

`formResetCallback` runs as part of [resetting the form](https://html.spec.whatwg.org/#concept-form-reset), in the context of:
- the call to `form.reset()`
- the call to `.click()` on a reset button, which enqueues the reaction on the backup element queue as `.click()` is not annotated with `[CEReactions]`
- the empty context, when the user clicks a reset button

`formStateRestoreCallback` always runs in the empty context, since restoring the state of a form control is always the user agent's decision (either when [restoring persisted state](https://html.spec.whatwg.org/#restore-persisted-state) as part of a navigation, or as part of a form-filling assist feature). This is true even when restoring persisted state runs synchronously while there is JavaScript on the stack, as part of a [fragment navigation](https://html.spec.whatwg.org/#navigate-fragid) started by it: the user agent must use the empty context when enqueuing the reaction, rather than capturing the current one.
