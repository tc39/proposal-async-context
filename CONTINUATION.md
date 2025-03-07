# Continuation flows

The proposal as it currently stands defines propagating context variables to
subtasks without feeding back any modifications in subtasks to the context of
their parent async task.

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

> Checkout [AsyncContext in other languages](./PRIOR-ARTS.md#asynccontext-in-other-languages)!

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
    // The continuation flow should be preserved here.
    cf.get() // => main
  })
})

function readFile(file, callback) {
  const snapshot = new AsyncContext.Snapshot()
  // readFile is composited with a series of sub-operations.
  fs.open(file, (err, fd) => {
    fs.read(fd, (err, text) => {
      fs.close(fd, (err) => {
        snapshot.run(callback. err, text)
      })
    })
  })
}
```

In the above example, callbacks can be composed naturally with the function
argument of `run(value, fn)` signature, and making it possible to feedback
the modification of the context of subtasks to the callbacks from outer scope.

```js
cf.run('main', () => {
  readFile(file, () => {
    // The continuation flow is a continuation of the fs.close operation.
    cf.get() // => `main -> fs.close`
  })
})

function readFile(file, callback) {
  const snapshot = new AsyncContext.Snapshot()
  // ...
  // omit the other part
  fs.close(fd, (err) => {
    snapshot.run(() => {
      cf.run(`${cf.get()} -> fs.close`, () => {
        callback(err, text)
      })
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

  await cf.run('inner', async () => {
    cf.get() // => 'inner'
    await task()
    cf.get() // => 'task-0'
  })

  cf.get() // => 'task-0'
}

let taskId = 0
async function task() {
  cf.get() // => 'inner'
  await cf.run(`task-${taskId++}`, async () => {
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
`valueStore` being the corresponding context variable (`AsyncContext.Variable` and
`ContinuationFlow`) in each semantic:

```js
let taskId = 0
function randomTask() {
  return valueStore.run(`task-${taskId++}`, async () => {
    await scheduler.wait(Math.random * 10)
    if (Math.random() >= 0.5) {
      throw new Error()
    }
  })
}
```

### Example

We'll take `Promise.all` as an example since it merges when all promises
fulfills and take a short-circuit when any of the promises is rejected.

```js
valueStore.run('main', async () => {
  try {
    await Promise.all(_.times(5).map((it) => randomTask()))
    valueStore.get() // => site (1)
  } catch (e) {
    valueStore.get() // => site (2)
  }
})
```

From different observation perspectives, the value at site (1) would be
different on the above semantics.

For `AsyncContext.Variable`, it is `main`.

For `ContinuationFlow`, it needs a mechanism to resolve the merge
conflicts, and pick a winner to be the default current context:

```js
await Promise.all([
  task({ id: 1, duration: 100 }), // (1)
  task({ id: 2, duration: 1000 }), // (2)
  task({ id: 3, duration: 100 }), // (3)
])
valueStore.get() // site (4)
valueStore.getAggregated() // site (5)
```

The return value at site (4) could be either the first one in the iterator, as
the context of task (1), or the last finished one in the iterator, as the
context of task (2). And the return value at site (5) could be an aggregated
array of all the values [(1), (2), (3)].

The value at site (2):

- For `AsyncContext.Variable`, it is `main`,
- For `ContinuationFlow`, it is the one caused the rejection, and discarding
  leaf contexts of promises that may have been fulfilled.

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
const gPromise = valueStore.run('global', () => { // (1)
  return Promise.resolve(1)
})

valueStore.run('main', main) // (2)
async function main() {
  await gPromise
  // -> global ---
  //              \
  // -> main   ----> (3)
  valueStore.get() // site (3)
}
```

The value at site (3):

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

Or alternatively, a new `PromiseRejectionEvent` property can be defined as:

- `asyncSnapshot`: the context relevant to the promise that being rejected.

For a promise created with the `PromiseConstructor` or `Promise.withResolvers`,
the promise can be rejected in a different context:

```js
let reject
let p1
valueStore.run('init', () => { // (1)
  ;({ p1, reject } = Promise.withResolvers())
})

valueStore.run('reject', () => { // (2)
  reject('error message')
})

addEventListener('unhandledrejection', (event) => {
  event.asyncSnapshot.run(() => {
    valueStore.get() // site (3)
  })
})
```

In this case, the `unhandledrejection` event will be dispatched with the promise
instance `p1` and a string of `'error message'`, and the event is scheduled in
the context of `'reject'`.

For the two type of context variables with `unhandledrejection` event of `p1`
at site (3):

- For `AsyncContext.Variable`, the context is `'reject'`, where `p1` was rejected.
- For `ContinuationFlow`, the context is `'reject'`, where `p1` was rejected.

---

However, if this promise was handled, and the new promise didn't have a proper
handler:

```js
let reject
let p1
valueStore.run('init', () => { // (1)
  ;({ p1, reject } = Promise.withResolvers())
  const p2 = p1 // p1 is not settled yet
    .then(undefined, undefined)
})

valueStore.run('reject', () => { // (2)
  reject('error message')
})

addEventListener('unhandledrejection', (event) => {
  event.asyncSnapshot.run(() => {
    valueStore.get() // site (3)
  })
})
```

The `unhandledrejection` event will be dispatched with the promise
instance `p2` with a string of `'error message'`. In this case, the event is
scheduled in a new microtask which was scheduled in the context of `'reject'`.

For the two type of context variables, the value at site (3) with
`unhandledrejection` event of `p2`:

- For `AsyncContext.Variable`, the context is `'init'`, where `p2`
  attaches the promise handlers to `p1`.
- For `ContinuationFlow`, the context is `'reject'`, where `p1` was rejected.

---

If handlers were attached to an already rejected promise:

```js
let p1
valueStore.run('reject', () => { // (1)
  p1 = Promise.reject('error message')
})

valueStore.run('init', () => { // (2)
  const p2 = p1 // p1 is already rejected
    .then(undefined, undefined)
})

addEventListener('unhandledrejection', (event) => {
  event.asyncSnapshot.run(() => {
    valueStore.get() // site (3)
  })
})
```

In this case, the `unhandledrejection` event is scheduled in the context where
`.then` is called, that is `'init'`.

> By saying "the `unhandledrejection` event is scheduled" above, it is
> referring to [HostPromiseRejectionTracker](https://html.spec.whatwg.org/#the-hostpromiserejectiontracker-implementation).
> This host hook didn't actually "schedule" the event dispatching, rather putting the
> promise in a queue and the event is actually scheduled from [event loop](https://html.spec.whatwg.org/#notify-about-rejected-promises).

For the two type of context variables, the value at site (3) with
`unhandledrejection` event of `p2`:

- For `AsyncContext.Variable`, the context is `'init'`, where `p2`
  attaches the promise handlers to `p1`.
- For `ContinuationFlow`, the context is `'reject'`, where `p1` was rejected.

### Fulfilled promises

The two proposed semantics are not always following the most relevant cause's
context to reduce undeterministic behavior. Similar to the rejected promise
issue, the MOST relevant cause's context when scheduling a microtask for newly
created promise handlers is unobservable from JavaScript:

```js
let p1
valueStore.run('resolve', () => { // (1)
  p1 = Promise.resolve('yay')
})

valueStore.run('init', () => { // (2)
  const p2 = p1 // p1 is already resolved
    .then(() => {
      valueStore.get() // site (3)
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
let p1
valueStore.run('resolve', () => { // (1)
  p1 = Promise.resolve('yay')
})

valueStore.run('init', () => { // (2)
  const p2 = then(p1, undefined) // p1 is already resolved
    .then(() => {
      valueStore.get() // site (3)
    })
})
```

The context at site (3) represents the context triggered the logical execution
of the promise fulfillment handler. In this case, the most relevant cause's
context at site (2) would be `'init'` since in this context, the microtask is
scheduled.

However, since if a promise is settled or not is not observable from JS, a data
flow that always following the MOST relevant cause's context would be
undeterministic and exposes a new approach to inspect the promise internal
state.

The two proposed semantics are not always following the most relevant cause's
context to reduce undeterministic behavior. And the values at site (2) are
regardless of whether the promise was fulfilled or not:

- For `AsyncContext.Variable`, the context is constantly `'init'`.
- For `ContinuationFlow`, the context is constantly `'resolve'`.

## Follow-up

It has been generally agreed that the two type of context variables have their
own unique use cases and may co-exist.

Given that the flow of `AsyncContext.Variable` is widely available in [other languages](./PRIOR-ARTS.md#asynccontext-in-other-languages),
this proposal will focus on this single type of context variable. With this
proposal advancing, `ContinuationFlow` could be reified in a follow-up
proposal.
