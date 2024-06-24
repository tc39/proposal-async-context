# Continuation flows

The proposal as it currently stands defines that a context variable by
propagating values to subtasks without feeding back any modifications in
subtasks to the context of their parent async task.

```js
const asyncVar = new AsyncContext.Variable()

asyncVar.run('main', main)

async function main() {
  asyncVar.get() // => 'main'

  await asyncVar.run('inner', async () => {
    asyncVar.get() // => 'inner'
    await task()
    asyncVar.get() // => 'inner'
    // value in this scope is not changed by subtasks
  })

  asyncVar.get() // => 'main'
  // value in this scope is not changed by subtasks
}

let taskId = 0
async function task() {
  asyncVar.get() // => 'inner'
  await asyncVar.run(`task-${taskId++}`, async () => {
    asyncVar.get() // => 'task-0'
    // ... async operations
    await 1
    asyncVar.get() // => 'task-0'
  })
}
```

In this model, any modifications are async task local scoped. A subtask
snapshots the context when they are scheduled and never propagates the
modification back to its parent async task scope.

> Checkout this example in other languages [gist](https://gist.github.com/jridgewell/ca75e91f78c6fa429af10271451a437d?permalink_comment_id=5077079).

Another semantic was proposed to improve traceability on determine the
continuation "previous" task in a logical asynchronous execution. In this
model, modifications made in an async subtask are propagated to its
continuation tasks.

It was initially proposed based on the callback style of async continuations.
We'll use the term "ContinuationFlow" in the following example.

```js
const cf = new ContinuationFlow()

cf.run('main', () => {
  readFile(file, () => {
    cf.get() // => main
  })
})

function readFile(file, callback) {
  // snapshot context at fs.open
  fs.open(file, (err, fd) => {
    // restore context before callback

    // snapshot context at fs.read
    fs.read(fd, (err, text) => {
      // restore context before callback

      // snapshot context at fs.close
      fs.close(fd, (err) => {
        // restore context before callback

        callback(err, text)
      })
    })
  })
}
```

In the above example, callbacks can be composed naturally with the function
argument of `run(value, fn)` signature, and makes it possible to feedback
the modification of the context of subtasks to the callbacks from outer scope.

```js
cf.run('main', () => {
  readFile(file, () => {
    cf.get() // => last operation: fs.close
  })
})

function readFile(file, callback) {
  // ...
  // omit the other part
  fs.close(fd, (err) => {
    cf.run('last operation: fs.close', () => {
      callback(err, text)
    })
  })
}
```

Since promise handlers are continuation functions as well, it suggests the
initial example to behave like:

```js
const cf = new ContinuationFlow()

cf.run('main', main)
async function main() {
  cf.get() // => 'main'

  await ctx.run('inner', async () => {
    cf.get() // => 'inner'
    await task()
    cf.get() // => 'task-0'
  })

  cf.get() // => 'task-0'
}

let taskId = 0
async function task() {
  cf.get() // => 'inner'
  await ctx.run(`task-${taskId++}`, async () => {
    const id = cf.get() // => 'task-0'
    // ... async operations
    await 1
    cf.get() // => can be anything from above async operations

    // Forcefully reset the ctx
    return cf.run(id, () => Promise.resolve())
  })
}
```

In this model, any modifications are passed along with the continuation flow.
An async subtask snapshots the context when they are continued from (either
fulfilled or rejected) and restores the continuation snapshot when invoking the
continuation callbacks.

## Comparison

There are several properties that both semantics persist yet with different
semantics:

- Implicit-propagation: both semantics would propagate contexts based on
  language built-in structures, allowing implicit propagation across call
  boundaries without explicit parameter-passing.
  - If there are no modifications in any subtasks, the two would be
    practically identical.
- Causality: both semantics don't use the MOST relevant cause as its parent
  context because the MOST relevant causes can be un-deterministic and lead to
  confusions in real world API compositions (as in
  [`unhandledrejection`](#unhandled-rejection) and
  [Fulfilled promises](#fulfilled-promises)).

However, new issues arose for the continuation flow semantic:

- Merge-points: as feeding back the modifications to the parent scope, there
  must be a strategy to handle merge conflicts.
- Cutting Leaf-node: it is proposed that the continuation flow is specifically
  addressing the issue that modifications made in leaf-node of an async graph are
  discarded, yet the current semantic doesn't not handle the leaf-node cutting
  problem in all edge cases.

## Promise operations

Promise is the basic control-flow building block in async codes. Since promises
are first-class values, they can be passed around, aggregated, and so on.
Promise handlers can be attached to a promise in a different context than the
creation context of the promise.

The following promise aggregation APIs may be a merge point where multiple
promises are merged into one single promise, or short-circuit in conditions
picking one single winner and discarding all other states.

| Name                 | Description                                     | On-resolve    | On-reject     |
| -------------------- | ----------------------------------------------- | ------------- | ------------- |
| `Promise.allSettled` | does not short-circuit                          | Merge         | Merge         |
| `Promise.all`        | short-circuits when an input value is rejected  | Merge         | Short-circuit |
| `Promise.race`       | short-circuits when an input value is settled   | Short-circuit | Short-circuit |
| `Promise.any`        | short-circuits when an input value is fulfilled | Short-circuit | Merge         |

To expand on the behaviors, given a task with the following definition, with
`ctx` being the corresponding context variable (`AsyncContext.Variable` and
`ContinuationFlow`) in each semantic:

```js
let taskId = 0
function randomTask() {
  return ctx.run(`task-${taskId++}`, async () => {
    await scheduler.wait(Math.random * 10)
    if (Math.random() >= 0.5) {
      throw new Error()
    }
  })
}
```

### `Promise.allSettled`

It is a merge point on `Promise.allSettled`. It aggregates the promise results
that are either resolved or rejected.

```js
ctx.run('main', async () => {
  await Promise.allSettled(_.times(5).map((it) => randomTask()))
  ctx.get() // => (1)
})
```

From different observation perspectives, the value at site (1) would be
different on the above semantics:

- For `AsyncContext.Variable`, it is `main`,
- For `ContinuationFlow`, the proposed solution didn't specify
  conflicts-resolving yet. If the default behavior merges the values in an
  array, it changes the shape of the value.

### `Promise.all`

In the resolving path, `Promise.all` is similar to `Promise.allSettled` that it
is a merge point when all promises resolve.

`Promise.all` picks the fastest reject promise.

```js
ctx.run('main', async () => {
  try {
    await Promise.all(_.times(5).map((it) => randomTask()))
    ctx.get() // => (1)
  } catch (e) {
    ctx.get() // => (2)
  }
})
```

The value at site (1):

- For `AsyncContext.Variable`, it is `main`,
- For `ContinuationFlow`, the proposed solution didn't specify
  conflicts-resolving yet.

The value at site (2):

- For `AsyncContext.Variable`, it is `main`,
- For `ContinuationFlow`, it is the one caused the rejection, and discarding
  leaf contexts of promises that may have been fulfilled.

### `Promise.race`

`Promise.race` picks the fastest settled (either fulfilled or rejected) promise.

```js
ctx.run('main', async () => {
  try {
    await Promise.race(_.times(5).map((it) => randomTask()))
    ctx.get() // => (1)
  } catch (e) {
    ctx.get() // => (2)
  }
})
```

The value at sites (1) and (2):

- For `AsyncContext.Variable`, it is `main`,
- For `ContinuationFlow`, it is the one caused the settlement.

### `Promise.any`

In a happy path, `Promise.any` is similar to `Promise.race` that it picks the
fastest resolved promise. However, it aggregates the exception values when all
the promises are rejected.

It is a merge point when exception values are aggregated.

```js
ctx.run('main', async () => {
  try {
    await Promise.any(_.times(5).map((it) => randomTask()))
    ctx.get() // => (1)
  } catch (e) {
    ctx.get() // => (2)
  }
})
```

The value at site (1):

- For `AsyncContext.Variable`, it is `main`,
- For `ContinuationFlow`, it is the one caused the fulfillment, and discarding
  leaf contexts of promises that may have been rejected.

The value at site (2):

- For `AsyncContext.Variable`, it is `main`,
- For `ContinuationFlow`, the proposed solution didn't specify
  conflicts-resolving yet.

### Graft promises from outer scope

The state of a resolved or rejected promise never changes, as in primitives or
object identities. `Promise.prototype.then` creates a new promise from an
existing one and automatically bubbles the return value and the exception
to the new promise.

`await` operations are meant to be practically similar to a
`Promise.prototype.then`.

By awaiting a promise created outside of the current context, the two
executions are grafted together and there is a merge point on `await`.

```js
const gPromise = ctx.run('global', () => {
  return Promise.resolve(1)
})

ctx.run('main', main)
async function main() {
  await gPromise
  // -> global ---
  //              \
  // -> main   ----> (1)
  ctx.get() // (1)
}
```

The value at site (1):

- For `AsyncContext.Variable`, it is `main`,
- For `ContinuationFlow`, it is `global`, discarding the leaf context before
  `await` operation.

### Unhandled rejection

Unhandled rejection events are tasks that is scheduled when
[HostPromiseRejectionTracker](https://tc39.es/ecma262/#sec-host-promise-rejection-tracker)
is invoked.

The `PromiseRejectionEvent` instances of unhandled rejection events are emitted
with the following properties:

- `promise`: the promise which has no handler,
- `reason`: the exception value.

Intuitively, the context of the event should be relevant to the promise
instance attached to the `PromiseRejectionEvent` instance.

For a promise created with the `PromiseConstructor` or `Promise.withResolvers`,
the promise can be rejected in a different context:

```js
let reject
let p1 // (1)
ctx.run('init', () => {
  ;({ p1, reject } = Promise.withResolvers())
})

ctx.run('reject', () => {
  reject('error message')
})

addEventListener('unhandledrejection', (event) => {
  ctx.get() // (2)
})
```

In this case, the `unhandledrejection` event will be dispatched with the promise
instance `p1` and a string of `'error message'`, and the event is scheduled in
the context of `'reject'`.

For the two type of context variables with `unhandledrejection` event of `p1`:

- For `AsyncContext.Variable`, the context is `'reject'`, where `p1` was rejected.
- For `ContinuationFlow`, the context is `'reject'`, where `p1` was rejected.

---

However, if this promise was handled, and the new promise didn't have a proper
handler:

```js
let reject
let p1 // (1)
ctx.run('init', () => {
  ;({ p1, reject } = Promise.withResolvers())
  const p2 = p1 // p1 is not settled yet
    .then(undefined, undefined)
})

ctx.run('reject', () => {
  reject('error message')
})

addEventListener('unhandledrejection', (event) => {
  ctx.get() // (2)
})
```

The `unhandledrejection` event will be dispatched with the promise
instance `p2` with a string of `'error message'`. In this case, the event is
scheduled in a new microtask which was scheduled in the context of `'reject'`.

For the two type of context variables, the value at site (2) with
`unhandledrejection` event of `p2`:

- For `AsyncContext.Variable`, the context is `'init'`, where `p2`
  attaches the promise handlers to `p1`.
- For `ContinuationFlow`, the context is `'reject'`, where `p1` was rejected.

---

If handlers were attached to an already rejected promise:

```js
let p1 // (1)
ctx.run('reject', () => {
  p1 = Promise.reject('error message')
})

ctx.run('init', () => {
  const p2 = p1 // p1 is already rejected
    .then(undefined, undefined) // (2)
})

addEventListener('unhandledrejection', (event) => {
  ctx.get() // (2)
})
```

In this case, the `unhandledrejection` event is scheduled in the context where
`.then` is called, that is `'init'`.

> By saying "the `unhandledrejection` event is scheduled" above, it is
> referring to [HostPromiseRejectionTracker](https://html.spec.whatwg.org/#the-hostpromiserejectiontracker-implementation).
> This host hook didn't actually "schedule" the event dispatching, rather putting the
> promise in a queue and the event is actually scheduled from [event loop](https://html.spec.whatwg.org/#notify-about-rejected-promises).

For the two type of context variables, the value at site (2) with
`unhandledrejection` event of `p2`:

- For `AsyncContext.Variable`, the context is `'init'`, where `p2`
  attaches the promise handlers to `p1`.
- For `ContinuationFlow`, the context is `'reject'`, where `p1` was rejected.

### Fulfilled promises

Similar to the rejected promise issue, the MOST relevant cause's context when
scheduling a microtask for newly created promise handlers are not
deterministic:

```js
let p1 // (1)
ctx.run('resolve', () => {
  p1 = Promise.resolve('yay')
})

ctx.run('init', () => {
  const p2 = p1 // p1 is already resolved
    .then(() => {
      ctx.get() // (2)
    })
})
```

[`PerformPromiseThen`](https://tc39.es/ecma262/#sec-performpromisethen) calls
[`HostEnqueuePromiseJob`](https://html.spec.whatwg.org/#hostenqueuepromisejob),
which immediately queues a new microtask to call the promise fulfill reaction.

Explaining in the callback continuation form, this would be:

```js
// `Promise.prototype.then` in plain JS.
const then = (p, onFulfill) => {
  if (p[PromiseState] === 'FULFILLED') {
    let { resolve, reject, promise } = Promise.withResolvers()
    queueMicrotask(() => {
      resolve(onFulfill(promise[PromiseResult]))
    })
    return promise
  }
  // ...
}
let p1 // (1)
ctx.run('resolve', () => {
  p1 = Promise.resolve('yay')
})

ctx.run('init', () => {
  const p2 = then(p1, undefined) // the promise is already resolved
})
```

In this case, the MOST relevant context would be `'init'` since in this
context, the microtask is scheduled. However, since it is not observable from
JS if a promise is settled or not, actual continuation flow would be
undeterministic and exposes a new approach to inspect the promise internal
state.

For the two type of context variables, the value at site (2):

- For `AsyncContext.Variable`, the context is `'init'`.
- For `ContinuationFlow`, the context is still `'resolve'`.

## Follow-up

It has been generally agreed that the two type of context variables have their
own unique use cases and may co-exist. With this AsyncContext proposal advancing,
`ContinuationFlow` could be reified in a follow-up proposal.
