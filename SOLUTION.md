# Solution

## AsyncLocal Values Propagation

The key problem in AsyncLocal is how the values of AsyncLocal will be
propagated along with the async execution flow.

We'll still have the example from [README.md][] for a introduction.

```js
const context = new AsyncLocal();

(function main() {
  context.setValue('main');

  // (1)
  setTimeout(() => {
    printContext(); // => 'main'
    context.setValue('first timer');
    setTimeout(() => {
      printContext(); // => 'first timer'
    }, 1000);
  }, 1000);

  // (2)
  setTimeout(() => {
    printContext(); // => 'main'
    context.setValue('second timer');
    setTimeout(() => {
      printContext(); // => 'second timer'
    }, 1000);
  }, 1000);
})();

function printContext() {
  console.log(context.getValue());
}
```

In the example above, the `main` function first filled the AsyncLocal with
value `'main'` by `context.setValue('main')`, then it called `setTimeout` twice
consecutively. In the callback of `setTimeout`, first the value of AsyncLocal
were printed, then each callback of `setTimeout` set AsyncLocal with different
value `'first time'` and `'second time'` respectively. After the value set,
both callback of `setTimeout` initiated with a new `setTimeout` with a callback
to print the value of AsyncLocal.

The notable things are that we have `context.setValue` been placed in a nested
callback of `setTimeout`, an asynchronous API provided by many outstanding
hosts like web browsers and Node.js. Why is this necessary? Can we replace
the `setTimeout` with an async function and `await` them? Like following
snippet:

```js
const context = new AsyncLocal();

(async function main() {
  context.setValue(0);

  await Promise.all([ test(), test() ]);
  printContext();
})();

async function test() {
  printContext();
  context.setValue(context.getValue() + 1);
}

function printContext() {
  console.log(context.getValue());
}
```

The issue in the above example is that both `test()` call in `main` is executed
synchronously with `main`, there isn't any new value propagation effected by
calling an async function as they can be desugared as following:

```js
function main() {
  return new Promise((resolve, reject) => {
    context.setValue(0);
    var result = Promise.all([ test(), test() ]);
    Promise.resolve(result)
      .then(() => {
        printContext();
        resolve(undefined);
      });
  });
}

function test() {
  return new Promise((resolve, reject) => {
    printContext();
    context.setValue(context.getValue() + 1);
    resolve(undefined);
  });
}
```

The output of snippet above will be:

```log
0 // test: printContext();
1 // test: printContext();
2 // main: printContext();
```

> For more async function evaluation definition, checkout [25.7.5.1 AsyncFunctionStart][].

That is to say, the value propagation will only happen on each call like
closure of [PromiseReactionJob][]s' were invoked, or callbacks of host defined
async operation like `setTimeout` were invoked.

The propagation operation in the section doesn't mean an actual propagation
operation should be effective immediately. It is possible to link those async
operation by the time of invocation like `Promise.resolve(value)`. As such,
one of the major design goal of current `AsyncLocal` value propagation can be
fulfilled by leveraging the performance hit to the time when we explicitly call
`AsyncLocal.getValue()`. The applications that didn't use any AsyncLocal
features will not be punished for the implementation of AsyncLocal.

### Stop propagation

Since the value propagation of AsyncLocal acts automatically, how do we stop a
value from been propagated? The recommended way is
`AsyncLocal.setValue(undefined)`. As the propagation is designed to be
lightweight enough as long as there is no actual `AsyncLocal.getValue()` been
called, setting the value of AsyncLocal to `undefined` is sufficient in ways
to stop the value propagation.

[README.md]: ./README.md
[25.7.5.1 AsyncFunctionStart]: https://tc39.es/ecma262/#sec-async-functions-abstract-operations-async-function-start
[PromiseReactionJob]: https://tc39.es/ecma262/#sec-promise-jobs
