# Scoping of AsyncLocal

The major concerns of AsyncLocal advancing to Stage 1 of TC39 proposal process
is that there are potential dynamic scoping of the semantics of AsyncLocal.
This document is about defining the scoping of AsyncLocal.

### Dynamic Scoping

A classic dynamic scoping issue is: the name `x` in `g` will be determined by
the callee of `g`. If `g` is called at root scope, the name `x` refers to the
one defined in the root scope. If `g` is called in `f`, the name `x` refers to
the one defined in the scope of `f`.

```js
$ # bash language
$ x=1
$ function g () { echo $x ; x=2 ; }
$ function f () { local x=3 ; g ; }
$ f # does this print 1, or 3?
3
$ echo $x # does this print 1, or 2?
1
```

However, the naming scope of async local is identical to a regular variable in
JavaScript. Since JavaScript variables are lexically scoped, the naming of
async local instances are lexically scoped too. It is not possible to access
an async local that are not explicitly referenced.

```js
const asyncLocal = new AsyncLocal();
asyncLocal.setValue(1);

function g() {
  console.log(asyncLocal.getValue(); // print 1;
  asyncLocal.setValue(2);
}
function f() {
  const asyncLocal = new AsyncLocal();
  asyncLocal.setValue(3);
  g();
}
f();

console.log(asyncLocal.getValue()); // print 2;
```

Hence, referencing the names of AsyncLocal instances have the same meaning with
regular variables in lexically scoped closures.

```js
const asyncLocal = new AsyncLocal();
asyncLocal.setValue(1);

function f() {
  const asyncLocal = new AsyncLocal();
  asyncLocal.setValue(3);
  g();
  function g() {
    console.log(asyncLocal.getValue(); // print 3;
    asyncLocal.setValue(2);
  }
}
f();

console.log(asyncLocal.getValue()); // print 1;
```

### Dynamic Scoping: dependency on callee

One argument on the dynamic scoping is that the values in AsyncLocal can be
changed depending on which the callee is.

However, the definition of whether the value of an async local can be changed
has the same meaning with a regular JavaScript variable: the JavaScript
variables changes all the time, even though it is encapsulated by the closure.

```js
const asyncLocal = new AsyncLocal();
let local;

function g() {
  console.log('asyncLocal:', asyncLocal.getValue();
  console.log('local:', local);
}
function f() {
  const asyncLocal = new AsyncLocal();
  let local;
  asyncLocal.setValue(3);
  local = 3;
  g();
}

asyncLocal.setValue(1);
local = 1;
f();
// => asyncLocal: 1;
// => local: 1;
asyncLocal.setValue(2);
local = 2;
f();
// => asyncLocal: 2;
// => local: 2;
```

### Dynamic Scoping: contexts

Can a closure capture the value of an async local that is relevant at a given
moment in time? As the value of async local is single-directed propagated,
value set in subsequent async callback will not be feed back to its original
context.

```js
const asyncLocal = new AsyncLocal();
let local;

(function main() {
  asyncLocal.setValue('1');
  local = '1';

  // (1)
  setTimeout(() => {
    console.log(asyncLocal.getValue()); // '1' is propagated.
    asyncLocal.setValue('2');
    setTimeout(() => {
      console.log(asyncLocal.getValue()); // '2' is propagated.
    }, 1000);
  }, 1000);

  // (2)
  setTimeout(() => {
    console.log(asyncLocal.getValue()); // '1' is propagated.
    asyncLocal.setValue('3');
    setTimeout(() => {
      console.log(asyncLocal.getValue()); // '3' is propagated.
    }, 1000);
  }, 1000);
})();
```

Even though the value of async local depends on in which context the async
flow is execution, the naming scope of async local is clear and identical to
regular JavaScript variables. The difference between regular JavaScript
variables and async locals is the value in the variable slot.

```js
const asyncLocal = new AsyncLocal();
let local;

function g() {
  console.log('asyncLocal:', asyncLocal.getValue();
  console.log('local:', local);
}
function f() {
  const asyncLocal = new AsyncLocal();
  let local;
  asyncLocal.setValue(3);
  local = 3;
  g();
}

asyncLocal.setValue(1);
local = 1;
setTimeout(f, 1);
// => asyncLocal: 1;
// value is propagated to the async flow.
// => local: 2;
// as following two line were evaluated before both run of `g`.
asyncLocal.setValue(2);
local = 2;
setTimeout(f, 1);
// => asyncLocal: 2;
// value is propagated to the async flow.
// => local: 2;
// as above two set were evaluated before both run of `g`.
```

Additional, the async locals behave identically to lexically scoped variables in
synchronous executions.

```js
const asyncLocal = new AsyncLocal();
let local;

(function main() {
  asyncLocal.setValue('1');
  local = '1';

  // (1)
  (function () => {
    console.log(asyncLocal.getValue()); // => '1'
    console.log(local); // => '1'
    asyncLocal.setValue('2');
    local = '2';
    (function () => {
      console.log(asyncLocal.getValue()); // => '2'
      console.log(local); // => '2'
    })();
  })();

  // (2)
  (function () => {
    console.log(asyncLocal.getValue()); // => '2'
    console.log(local); // => '2'
    asyncLocal.setValue('3');
    local = '3';
    (function () => {
      console.log(asyncLocal.getValue()); // => '3'
      console.log(local); // => '3'
    })();
  })();
})();
```

### Summary

There are no differences regarding naming scope of async locals between regular
JavaScript variables. AsyncLocal doesn't introduce dynamic scoping to the
naming scope of AsyncLocal instances. There are no changes regarding variable
naming scope in the proposal.
