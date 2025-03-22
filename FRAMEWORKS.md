# Frameworks & AsyncContext

Many popular web frameworks are eagerly waiting on the `AsyncContext` proposal, either to improve experience for their users (application developers) or to reduce footguns.

This document lists the concrete reasons that different frameworks have for using `AsyncContext`.

Note: **[client]** and **[server]** markers in messages have been added by the proposal's champions.

---

## [React](https://react.dev/)

> **[client]** In React, **transitions** are a feature that allows gracefully coordinating the...transition...of the UI from a start through to and end state while avoiding undesired intermediate states. For example, when navigating to a new route in an application, transitions can be used to temporarily continue to display the previous page with a loading indicator, asynchronously prepare the new page (including loading async resources such as data, images, fonts, etc), and show a crafted sequence of loading screens - while also reverting the loading states at the right times automatically.
>
> **[client+server]** React also supports **actions** which allow submitting data or performing other async writes that also trigger a transition of the UI to a new state. For example, submitting a form and seamlessly transitioning to the page for the entity you just created, without undesirable intermediate states being displayed.
>
> Both of these APIs require React to understand that a series of state changes, executed across asynchronous yield points, should be coordinated together into a single UI transition. The key challenge today is that while React is responsible for the coordination of a transition, the asynchronous code being executed is not only used-defined, but also not necessarily local (ie the transition might be calling into multiple levels of helper functions that actually await or trigger a state change). There is no way for React to automatically thread the right context through user-defined code in today's JavaScript.
>
> For example with a transition:
>
> ```js
> startTransition(async () => {
>   await someAsyncFunction();
>   // ❌ Not using startTransition after await
>   // React has no way to know this code was originally part of a transition
>   // w/o AsyncContext
>   setPage('/about');
> });
> ```
>
> Or an action:
>
> ```js
> <form action={async () => {
>   const result = await getResult();
>   // ❌ Not using startTransition after await
>   // React has no way to know this code was originally part of a transition
>   // w/o AsyncContext
>   someFunction(result); // internally calls setState
> }>
>   ...
> </form>
> ```
>
> For completeness sake, the main theoretical alternatives would be for React to:
>
>     1. Require developers to explicitly pass through a context object through all of their async code consumed by React. It would be difficult or impractical to lint against proper usage of this approach, making it easy for developers to forget to pass this value.
>
>     2. Attempt to compile _all_ async/await code that might appear in a React application to automatically pass through the context. Compiling React code for React is one thing, compiling all user code for React is invasive and a non-starter.
>
> That leaves us with needing some built-in way to associate a context across async yield points. Crucially, this is not just a framework concern but something that impacts how users write asynchronous code, since the workarounds are for them to write code differently. We understand that the specific solution here may have performance and/or complexity concerns and are happy to collaborate on alternative implementations if they can provide a similar capability.

The following is a quote [from the React docs](https://react.dev/reference/react/useTransition#troubleshooting) showing a developer error that is common enough to be included in their documentation, and that would be solved by browsers providing `AsyncContext` support.

> ### Troubleshooting
> #### React doesn’t treat my state update after `await` as a Transition
>
> **[client]** When you use await inside a startTransition function, the state updates that happen after the await are not marked as Transitions. You must wrap state updates after each await in a startTransition call:
>
> ```javascript
> startTransition(async () => {
>   await someAsyncFunction();
>   // ❌ Not using startTransition after await
>   setPage('/about');
> });
> ```
>
> However, this works instead:
>
> ```javascript
> startTransition(async () => {
>   await someAsyncFunction();
>   // ✅ Using startTransition *after* await
>   startTransition(() => {
>     setPage('/about');
>   });
> });
> ```
>
> This is a JavaScript limitation due to React losing the scope of the async context. In the future, when AsyncContext is available, this limitation will be removed.
>
> — <cite>Joseph Savona, React team</cite>

## [Solid](https://www.solidjs.com/)

> We're pretty excited about having standard AsyncContext API.
>
> ### Server
>
> Currently in Solid we use AsyncLocalStorage on the server in SolidStart our metaframework as a means of RequestEvent and ResponseEvent injection. We find this so important it is built into the core of Solid. And leveraged in a few important ways.
>
> First, Our Server Functions (compiled RPCs denoted by `"use server"`) have an isomorphic type safe interface intended to swap into any existing client side API. This means getting the Request in isn't part of the function signature and needs to be injected.
>
> Secondly, we need a mechanism for ecosystem libraries to tap into the request so provide important metadata. For example the Solid Router exporting matches and having a place to put the Response(say to handle redirects on the server) or registering of assets. Its important enough for us to handle this core so we don't fracture the metaframework ecosystem and all libraries can work regardless of which you choose (SolidStart, Tanstack or whatever)
>
> We've manufactured mechanisms for this in the past but they required special wrappers because you can't resume our context on the other side of an `await` when inside user code.
>
> While we have been fortunate that most platforms have polyfilled AsyncLocalStorage it remains difficult for platforms like Stackblitz which is built on webcontainers and is relying on AsyncContext to bring these features to the browser environments. To this day while we run most examples on Stackblitz their capability is greatly reduced impacting it's ability to act as good place to reproduce and build SolidStart projects.
>
> ### Client
>
> Modern JS frameworks work off context/synchronous scope. This is even more pronounced in Signals based frameworks because there is often both the tracking scope (ie collecting dependencies) and the ownership context which collects nested Signals to handle automatic disposal.
>
> Once you go async you lose both contexts. For the most part this is OK. From Solid's perspective tracking is synchronous by design. Some Signals libraries will want to continue tracking after:
> ```javascript
> createEffect(async () => {
>   const value1 = inputSignal() // track dep
>   const asyncValue = await fetch(value1);
>   const value2 = inputSignal2(); // can we track here??
>   const asyncValue2 = await fetch(asyncValue, value2);
>   doEffect(asyncValue2)
> })
> ```
>
> But ownership would definitely benefit from being able to re-inject our context back in. The potential applications honestly are numerous. `await` in user code without special wrappers, resuming async sequences like in our Transaction or Transition API, pausing and resuming hydration during streaming.
>
> There is a world where we'd just use this mechanism as our core context mechanism. I have performance concerns there which I wouldn't take lightly, but mechanically we are just remaking this in every JavaScript framework and given where things are going I only expect to see more of this.
>
> — <cite>Ryan Carniato, Solid maintainer</cite>

## [Svelte](https://svelte.dev/)

<!--
> **[client]** We would like to add support for async state to Svelte 5. For example, we would like to allow `await` at the top level of Svelte component.
> However because we use signal reactivity for tracking, and `await` means losing the reactive context, we would have to leverage the fact that Svelte is a compiler and essentially wrap the `await` expressions so we resume it magically. If we had AsyncContext, we would be use to rely on the native JavaScript semantics, rather than having to work them around through compilation.
>
> — <cite>Dominic Gannaway, Svelte maintainer</cite>
-->

> The Svelte team are eagerly awaiting the day we can use `AsyncContext`. The widespread adoption of `AsyncLocalStorage` across different packages (and runtimes, despite its non-standard status) is clear evidence that real use cases exist; there is no a priori reason to assume that those use cases are restricted to server runtimes, and indeed there are two concrete examples where our hands are currently tied by the lack of this capability in the browser: **[server]** we're introducing a `getRequestEvent` function in SvelteKit that allows functions on the server to read information about the current request context (including things like the requested URL, cookies, headers etc), even if the function isn't called synchronously (which is necessary for it to be generally useful).
>
> **[client]** Ideally we would have a similar function, `getNavigationEvent`, which would apply similarly to client-side navigations; this is currently impossible as reactivity in Svelte is signal-based. The dependencies of a given reaction are determined by noting which signals are read when the reaction executes. We are working on a new asynchronous reactivity model, which requires that dependencies can be tracked even if they are read after the initial execution (for example `<p>{await a + await b}</p>` should depend on both `a` and `b`). As a compiler-based framework, we can fudge this by transforming the `await` expressions, but we can only do this in certain contexts, leading to confusing discrepancies. Other frameworks don't even have this option, and must resort to an inferior developer experience instead.
> Given these, and other use cases that we anticipate will emerge, we fully support the AsyncContext proposal.
>
> — <cite>Rich Harris, Svelte maintainer</cite>

There are [good examples on Reddit](https://www.reddit.com/r/sveltejs/comments/1gyqf27/svelte_5_runes_async_a_match_made_in_hell/) of Svelte users frustrated because it's not able to preserve context through async operations.

The missing async support is also explicitly called out [in their documentation](https://svelte.dev/docs/svelte/$effect#Understanding-dependencies):

> `$effect` automatically picks up any reactive values (`$state`, `$derived`, `$props`) that are synchronously read inside its function body (including indirectly, via function calls) and registers them as dependencies. When those dependencies change, the `$effect` schedules a re-run.
>
> Values that are read _asynchronously_ — after an `await` or inside a `setTimeout`, for example — will not be tracked. Here, the canvas will be repainted when color changes, but not when size changes:
>
> ```javascript
> $effect(() => {
>   const context = canvas.getContext('2d');
>   context.clearRect(0, 0, canvas.width, canvas.height);
>
>   // this will re-run whenever `color` changes...
>   context.fillStyle = color;
>
>   setTimeout(() => {
>     // ...but not when `size` changes
>     context.fillRect(0, 0, size, size);
>   }, 0);
> });
> ```

## [Vue](https://vuejs.org/)

> AsyncContext is an important feature to have in JavaScript ecosystem. Patterns like singleton is a very common practice in many languages and frameworks. Things that `getCurrentComponent()` relying on a global singleton state work fine by introducing a stack in sync operations, but is becoming very challenging in async flows, there concurrent access to the global state will lead to race conditions. It currently has no workaround in JavaScript without a compiler magic (with a lot of false negatives).
>
> **[client]** Frameworks like Vue provides lifecycle hooks that requires such information, consider Vue 3 support mounting multiple apps at the same time, and some components can be async, the async context race conditions become a headache to us. So that we have to introduce the compiler magic to make it less mental burden to the users. **[server]** Similar stories happen in Nuxt and Nitro on the server side, where the server need to handle concurrent inbound requests, without a proper AsyncContext support, we are also having the risk to leaking information across different requests.
>
> **[client]** As "hooks" is also becoming a very popular API design for many frameworks, including React, Solid, Vue and so on. All these usage would more or less limited by the lack of AsyncContext. Specially since there is no easy runtime workaround/polyfill, I believe it's an essential feature that JavaScript is currently lacking
>
> — <cite>Anthony Fu, Vue maintainer</cite>

Vue currently has a transpiler that, at least for async/await, allows [emulating AsyncContext-like behavior](https://github.com/vuejs/core/blob/d48937fb9550ad04b1b28c805ecf68c665112412/packages/runtime-core/src/apiSetupHelpers.ts#L480-L498):

> We've actually been keeping an eye on that proposal for a while now. We have two very suitable use cases for it:
> 1. **[client]** _Restoring component context in an async setup flow._
>   In Vue, components can have an async `setup()` function that returns a `Promise`. But this creates a trap when using composables (equivalent of React hooks) that require an active component context:
>    ```javascript
>    useFoo()
>    await 1
>    useBar() // context lost
>    ```
>    Right now we can work around this by doing compiler transforms like this:
>    ```javascript
>    let __temp, __restore
>   
>    useFoo()
>    // transformed
>    ;(
>      ([__temp,__restore] = _withAsyncContext(() => 1)),
>      await __temp,
>      __restore()
>    )
>    useBar()
>    ```
>    But this only works when there is a build step with Vue single-file components, and does not work in plain JS. `AsyncContext` would allow us to use a native mechanism that works consistently in all cases.
> 2. **[client / devtools]** _Tracking state mutation during async actions in state management._
>    Our official state management lib Pinia (https://pinia.vuejs.org/) has a devtools integration that is able to trace action invocations, but currently there is no way to associate async state mutations to the owner action. A single action may trigger multiple state mutations at different times:
>    ```javascript
>    actions: {
>      async doSomething() {
>        // mutation 1
>        this.data = await api.post(...)
>        // mutation 2
>        this.user = await api.get(this.data.id)
>      }
>    }
>    ```
>    We want to be able to link each mutation triggered by `doSomething` to it and visualize it in the devtools. Again currently the only way to do it is compiler-based code instrumentations, but we don't want to add extra overhead to plain JS files. `AsyncContext` would make this easier without relying on compilers.
>
>
> — <cite>Evan You, Vue maintainer</cite>

## Wiz

> [!WARNING]
> Wiz is a Google-internal framework, not open source.

> Wiz is a Google-internal web application framework designed to meet the requirements of Google-scale applications. It focuses on performance, supporting lazy code loading for fast user response times and server-side rendering for fast initial page loads. Wiz offers high performance across the widest range of browsers, devices, and connection speeds.
>
> The Wiz team anticipates AsyncContext to be a critical component to instrumenting tracing in our signals-based framework. Tracing has been a top request to help users gain insight into the performance characteristics of specific user interactions. This work is currently underway and it's already evident that AsyncContext allows propagating important contextual information to async APIs that run user-provided callbacks. This is a very common design pattern in the framework and without the ability to propagate data across async boundaries, tracing would not be possible.

## [Pruvious](https://pruvious.com/)

> Pruvious is a CMS built on top of Nuxt. It can operate in a classic Node.js environment as well as in Cloudflare Workers, which run on the V8 engine with a limited subset of Node.js.
> **[server]** I believe that async context is crucial for providing an excellent developer experience in a CMS. Developers need consistent access to the currently logged-in user, the context language, and the request itself. Without this, it would be overwhelmingly complicated for developers to pass the current request event to each function provided by the CMS. This is why async context is heavily utilized in Pruvious.
> **[client]** While this works well on the server side, async context is unfortunately not universal. For instance, Pruvious users (developers) cannot reproduce issues in StackBlitz. If async context were supported in browsers, Pruvious could run in the browser just like Nuxt does. In addition to issue reproduction, I believe that running the CMS in the browser would greatly simplify the learning-by-example process for new users.
>
> — <cite>Muris Ceman, Pruvious maintainer</cite>
