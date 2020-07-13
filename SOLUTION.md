# Solution

## AsyncLocal Values Propagation

The key problem in AsyncLocal is how the values of AsyncLocal will be
propagated along with the async execution flow.

We'll still have the example from [README.md][] for a introduction.

```js
const asyncLocal = new AsyncLocal();

(function main() {
  asyncLocal.setValue('main');

  // (1)
  setTimeout(() => {
    console.log(asyncLocal.getValue()); // => 'main'
    asyncLocal.setValue('first timer');
    setTimeout(() => {
      console.log(asyncLocal.getValue()); // => 'first timer'
    }, 1000);
  }, 1000);

  // (2)
  setTimeout(() => {
    console.log(asyncLocal.getValue()); // => 'main'
    asyncLocal.setValue('second timer');
    setTimeout(() => {
      console.log(asyncLocal.getValue()); // => 'second timer'
    }, 1000);
  }, 1000);
})();
```

In the example above, the `main` function first filled the AsyncLocal with
value `'main'` by `asyncLocal.setValue('main')`, then it called `setTimeout` twice
consecutively. In the callback of `setTimeout`, first the value of AsyncLocal
were printed, then each callback of `setTimeout` set AsyncLocal with different
value `'first time'` and `'second time'` respectively. After the value set,
both callback of `setTimeout` initiated with a new `setTimeout` with a callback
to print the value of AsyncLocal.

The notable things are that we have `asyncLocal.setValue` been placed in a nested
callback of `setTimeout`, an asynchronous API provided by many outstanding
hosts like web browsers and Node.js. Why is this necessary? Can we replace
the `setTimeout` with an async function and `await` them? Like following
snippet:

```js
const asyncLocal = new AsyncLocal();

(async function main() {
  asyncLocal.setValue(0);

  await Promise.all([ test(), test() ]);
  console.log(asyncLocal.getValue());
})();

async function test() {
  console.log(asyncLocal.getValue());
  asyncLocal.setValue(asyncLocal.getValue() + 1);
}
```

The issue in the above example is that both `test()` call in `main` is executed
synchronously with `main`, there isn't any new value propagation effected by
calling an async function as they can be desugared as following:

```js
function main() {
  return new Promise((resolve, reject) => {
    asyncLocal.setValue(0);
    var result = Promise.all([ test(), test() ]);
    Promise.resolve(result)
      .then(() => {
        console.log(asyncLocal.getValue());
        resolve(undefined);
      });
  });
}

function test() {
  return new Promise((resolve, reject) => {
    console.log(asyncLocal.getValue());
    asyncLocal.setValue(asyncLocal.getValue() + 1);
    resolve(undefined);
  });
}
```

The output of snippet above will be:

```log
0 // test: console.log(asyncLocal.getValue());
1 // test: console.log(asyncLocal.getValue());
2 // main: console.log(asyncLocal.getValue());
```

> For more async function evaluation definition, checkout [25.7.5.1 AsyncFunctionStart][].

That is to say, the value propagation will only happen on each call like
closure of [PromiseReactionJob][]s' were invoked, or callbacks of host defined
async operation like `setTimeout` were invoked.

For that reason, normal recursive async function will not be punished on
performance.

```js
const asyncLocal = new AsyncLocal();

(async function main() {
  asyncLocal.setValue(0);

  await test();
  console.log(asyncLocal.getValue());
})();

async function test() {
  const value = asyncLocal.getValue();
  if (value < 100) {
    asyncLocal.setValue(value + 1);
    await test();
  };
}
```

The code snippet above will print `100`.

### How the value got propagated

As mentioned in [README.md][], AsyncLocal propagates values along the logical
async execution flow. While all above examples are storing primitive values in
the AsyncLocal, it is notable that the semantics for propagation of the value
is assignment but not deep copy.

```js
const asyncLocal = new AsyncLocal();

asyncLocal.setValue({});
setTimeout(() => {
  const ctx = asyncLocal.getValue();
  ctx.foo = 'bar';
  setTimeout(() => {
    console.log(asyncLocal.getValue()); // => { foo: 'bar' };
  }, 1000);
}, 1000);
```

In the example above, an object was stored in the AsyncLocal. Therefore, it is
possible to write properties on the object but not setting the value of the
AsyncLocal and not triggering `valueChangedListener`.

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
