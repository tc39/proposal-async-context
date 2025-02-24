# Prior Arts

AsyncContext-like API exists in languages/runtimes that support `await` syntax or coroutines.

The following table shows a general landscape of how the API behaves in these languages/runtimes.

| Language / API               | Continuation feedback   | Mutation Scope        |
| ---------------------------- | ----------------------- | --------------------- |
| dotnet `AsyncLocal`          | No implicit feedback    | In scope mutation     |
| dotnet `CallContext`         | No implicit feedback    | In scope mutation     |
| Go `context`                 | No implicit feedback    | In scope mutation     |
| Python `ContextVar`          | Both available          | In scope mutation     |
| Ruby `Fiber`                 | No implicit feedback    | In scope mutation     |
| Rust `tokio::task_local`     | No implicit feedback    | New scope mutation    |
| Dart `Zone`                  | No implicit feedback    | New scope mutation    |
| JS `Zone`                    | No implicit feedback    | New scope mutation    |
| Node.js `AsyncLocalStorage`  | No implicit feedback    | Both available        |

Explanation:
* [Continuation feedback](./CONTINUATION.md)
    * No implicit feedback: `await`, or passing context to subtasks, does not feedback mutations to the caller continuation.
    * Both available: `await` may and may not feedback mutations to the caller continuation.
* [Mutation scope](./MUTATION-SCOPE.md)
    * In scope mutation: `set` does not require a new function scope, and can modify in scope.
      * `async function`-like syntax in these languages usually implies a scope.
    * New scope mutation: `set` requires a new function scope.
    * Both available.
      * Node.js has an experimental `AsyncLocalStorage.enterWith` that mutates in scope. `async function` in JavaScript does not imply a mutation scope.

## AsyncContext in other languages

### dotnet

C# on .Net runtime provides syntax support of `async`/`await`, with [`AsyncLocal`][]
and [`CallContext`][] to propagate context variables.

Additional to `AsyncLocal`'s in-process propagation, `CallContext` also supports propagating
context variables via remote procedure calls. So `CallContext` API requires extra
[security grants](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.remoting.messaging.callcontext?view=netframework-4.8.1#remarks).

> Test it yourself: [dotnet fiddle](https://dotnetfiddle.net/Sx9ukw).

```csharp
using System;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;

public class Program
{
  static AsyncLocal<string> _asyncLocal = new AsyncLocal<string>();
  static async Task AsyncMain()
  {
    _asyncLocal.Value = "main";
    var t1 = AsyncTask("task 1", 200);
    Console.WriteLine("Called AsyncTask 1.");
    Console.WriteLine("   AsyncLocal value is '{0}'", _asyncLocal.Value);
    var t2 = AsyncTask("task 2", 100);
    Console.WriteLine("Called AsyncTask 2.");
    Console.WriteLine("   AsyncLocal value is '{0}'", _asyncLocal.Value);

    await Task.WhenAll(new List<Task>{ t1, t2 });
    Console.WriteLine("Awaited tasks.");
    Console.WriteLine("   AsyncLocal value is '{0}'", _asyncLocal.Value);
  }

  static async Task AsyncTask(string expectedValue, Int32 delay)
  {
    _asyncLocal.Value = expectedValue;
    await Task.Delay(delay);
    Console.WriteLine("In AsyncTask, expect '{0}'", expectedValue);
    Console.WriteLine("   AsyncLocal value is '{0}'", _asyncLocal.Value);
  }

  public static void Main()
  {
    AsyncMain().Wait();
  }
}
```


This prints:

```console
Called AsyncTask 1.
   AsyncLocal value is 'main'
Called AsyncTask 2.
   AsyncLocal value is 'main'
In AsyncTask, expect 'task 2'
   AsyncLocal value is 'task 2'
In AsyncTask, expect 'task 1'
   AsyncLocal value is 'task 1'
Awaited tasks.
   AsyncLocal value is 'main'
```

From the result, we can tell that:
- `AsyncLocal` can be modified with assignment, without an extra scope.
- Modification in a child task does not propagate to its sibling tasks.
- Modification to an `AsyncLocal` does not propagate to the caller continuation, i.e. `await` in caller.

### Go

Go is famous for its deep coroutine integration in the language. As such, is has a conventional
context propagation mechanism: by always manual passing the context as the first argument of a
function.

Go provides a package [`context`](https://pkg.go.dev/context) for combining arbitrary values into
a single `Context` opaque bag, so that multiple values can be passed as the first argument of a
function.

> Test it yourself: [Go Playground](https://go.dev/play/p/F-CvnEBZy2Z).

```go
package main

import (
  "context"
  "fmt"
)

func inner_fn(ctx context.Context) context.Context {
  // Context is immutable. Modifying a context creates a new context.
  ctx = context.WithValue(ctx, "FooKey", "inner")
  // Return it explicitly so that modification can be observable from parent scope.
  return ctx
}

func main() {
  ctx := context.WithValue(context.Background(), "FooKey", "main")
  inner := inner_fn(ctx)

  fmt.Println("main:", ctx.Value("FooKey"))
  fmt.Println("inner:", inner.Value("FooKey"))
}
```

This prints:

```console
main: main
inner: inner
```

From go's `context` API, we can tell that:
- `Context` is immutable, and modification creates a new `Context`.
- Modification in a child task does not propagate to its sibling tasks implicitly.
- Modification to a `Context` does not propagate to the caller continuation, i.e. caller's context.

### Python

Python's [`contextvars.ContextVar`](https://docs.python.org/3/library/contextvars.html#context-variables)
provides the ability to propagate context variables.

```python
import asyncio
from contextvars import ContextVar

current_task = ContextVar('current_task')

async def foo():
  print("foo task parent:", current_task.get())
  current_task.set("foo")
  await asyncio.sleep(2)
  print("foo task:", current_task.get())

async def bar():
  print("bar task parent:", current_task.get())
  current_task.set("bar")
  await asyncio.sleep(1)
  print("bar task:", current_task.get())

async def main():
  current_task.set("main")

  await asyncio.gather(
    foo(),
    bar(),
  )
  print("after gather:", current_task.get())

loop = asyncio.get_event_loop()
loop.run_until_complete(main())
```

This prints:

```console
foo task parent: main
bar task parent: main
bar task: bar
foo task: foo
after gather: main
```

From the result, we can tell that:
- `ContextVar` can be modified with `set` method, without an extra scope.
- Modification in a child task does not propagate to its sibling tasks.
- Modification to an `ContextVar` does not propagate to the caller continuation, i.e. `await` in caller.

This is the default `asyncio` scheduling behavior. Additional to `ContextVar`,
the `contextvars` package even allow manual context management in Python. This allows userland
scheduler to customize the propagation behavior around `await` with `context.copy`
and `context.run`. So, if a user run `context.run` without `asyncio` on an awaitable object,
it can achieve the following behavior:

```python
import asyncio
import contextvars
from contextvars import ContextVar

current_task = ContextVar('current_task')

async def foo():
  print("foo task parent:", current_task.get())
  current_task.set("foo")
  await asyncio.sleep(1)
  print("foo task:", current_task.get())

async def main():
  current_task.set("main")

  ctx = contextvars.copy_context()
  await ctx.run(foo)
  print("after await:", current_task.get())

loop = asyncio.get_event_loop()
loop.run_until_complete(main())
```

This prints:

```console
foo task parent: main
foo task: foo
after await: foo
```

This allows userland schedulers to implement different context propagation than the
`asyncio`'s default one.

### Ruby

Although Ruby's [Fiber](https://docs.ruby-lang.org/en/3.4/Fiber.html) does not provide a default
scheduler, it provides a bracket accessor to get/set context variables, like
`AsyncContext.Variable` does.

> Test it yourself: [Ruby Playground](https://try.ruby-lang.org/playground/#code=def+main%0A++%23+Fiber+coroutine%0A++Fiber%5B%3Afoo%5D+%3D+%22main%22%0A++f1+%3D+Fiber.new+do%0A++++puts+%22inner+1+parent%3A+%23%7BFiber%5B%3Afoo%5D%7D%22%0A++++Fiber%5B%3Afoo%5D+%3D+%221%22%0A++++Fiber.current.storage%0A++end%0A%09f2+%3D+Fiber.new+do%0A++++puts+%22inner+2+parent%3A+%23%7BFiber%5B%3Afoo%5D%7D%22%0A++++Fiber%5B%3Afoo%5D+%3D+%222%22%0A++++Fiber.current.storage%0A++end%0A++inner_ctx1+%3D+f1.resume%0A++inner_ctx2+%3D+f2.resume%0A++puts+%22main+%23%7BFiber%5B%3Afoo%5D%7D%22%0A++puts+%22inner+1+%23%7Binner_ctx1%5B%3Afoo%5D%7D%22%0A++puts+%22inner+2+%23%7Binner_ctx2%5B%3Afoo%5D%7D%22%0Aend%0A%0AFiber.new+do%0A++main%0Aend.resume&engine=cruby-3.3.0).

```ruby
def main
  # Fiber coroutine
  Fiber[:foo] = "main"
  f1 = Fiber.new do
    puts "inner 1 parent: #{Fiber[:foo]}"
    Fiber[:foo] = "1"
    Fiber.current.storage
  end
  f2 = Fiber.new do
    puts "inner 2 parent: #{Fiber[:foo]}"
    Fiber[:foo] = "2"
    Fiber.current.storage
  end
  inner_ctx1 = f1.resume
  inner_ctx2 = f2.resume
  puts "main #{Fiber[:foo]}"
  puts "inner 1 #{inner_ctx1[:foo]}"
  puts "inner 2 #{inner_ctx2[:foo]}"
end

Fiber.new do
  main
end.resume
```

This prints:

```console
inner 1 parent: main
inner 2 parent: main
main main
inner 1 1
inner 2 2
```

From the result, we can tell that:
- `Fiber` context variables can be modified with bracket assignment, without an extra scope.
- Modification in a child task does not propagates to its sibling tasks.
- Modification to a `Fiber` does not propagate to the caller continuation, i.e. `Fiber.resume` in caller.

### Rust

Rust only provides [`thread_local`](https://doc.rust-lang.org/std/macro.thread_local.html) in
the `std` crate. [`tokio.rs`](https://tokio.rs/) is a popular Rust asynchronous applications
runtime that provides a [`task_local`](https://tikv.github.io/doc/tokio/macro.task_local.html),
which is similar to `AsyncContext.Variable`.

> Test it yourself: [Rust Playground](https://play.rust-lang.org/?version=stable&mode=debug&edition=2021&gist=4fe346a17d62c20e2574a76cb5f99cc0).

```rust
use tokio::time::{sleep, Duration};

tokio::task_local! {
  static FOO: &'static str;
}

#[tokio::main]
async fn main() {
  FOO.scope("foo", async move {
    println!("main {}", FOO.get());

    let t1 = FOO.scope("inner1", async move {
      sleep(Duration::from_millis(200)).await;
      println!("inner1: {}", FOO.get());
    });
    let t2 = FOO.scope("inner2", async move {
      sleep(Duration::from_millis(100)).await;
      println!("inner2: {}", FOO.get());
    });
    futures::join!(t1, t2);
    println!("main {}", FOO.get());
  }).await;
}
```

This prints:
```console
main foo
inner2: inner2
inner1: inner1
main foo
```

From the tokio API, and the result, we can tell that:
- `task_local` can be only be modified with a `sync_scope` or a `scope`.
- Modification in a child task does not propagates to its sibling tasks.
- Modification to a `task_local` does not propagate to the caller continuation, i.e. `await` in caller.

### Dart

Dart's [Zone](https://api.dart.dev/dart-async/Zone-class.html) provides much more functionality
than the `AsyncContext.Variable` in this proposal. `Zone` covers the necessary propagation of
values that `AsyncContext.Variable` provides.

> Test it yourself: [DartPad](https://dartpad.dev/?id=76faca6b45df2a05f1bbc7ae7cbbf4c6).

```dart
import 'dart:async';

void main() async {
  await runZoned(() async {
    var task1 = runZoned(() async {
      await Future.delayed(Duration(seconds: 2));
      print("Task 1: ${Zone.current[#task]}");
    }, zoneValues: { #task: 'task1' });

    var task2 = runZoned(() async {
      await Future.delayed(Duration(seconds: 1));
      print("Task 2: ${Zone.current[#task]}");
    }, zoneValues: { #task: 'task2' });

    await Future.wait({ task1, task2 });
    print("main : ${Zone.current[#task]}");
  }, zoneValues: { #task: 'main' });
}
```

This prints:

```console
Task 2: task2
Task 1: task1
main : main
```

From the Dart Zone API, and the result, we can tell that:
- `Zone` can be only be modified with a new function scope.
- Modification in a child task does not propagates to its sibling tasks.
- Modification to an `Zone` does not propagate to the caller continuation, i.e. `await` in caller.

## AsyncContext in real world

### OpenTelemetry

> Test it yourself: [OpenTelemetry Demo](https://opentelemetry.io/docs/demo/docker-deployment/).
> This demo includes more than 10+ services and covers most popular programming languages.

Even though each language or runtime provides different shapes of async context variable
API, OpenTelemetry standardized how the tracing context should be like in OpenTelemetry
implementations.

The [OpenTelemetry Context Specification](https://github.com/open-telemetry/opentelemetry-specification/tree/main/specification/context)
requires that each write operation to a `Context` must result in the creation of a new `Context`.
This eliminates the confusion could be caused by language context APIs that if a mutation
happens after an async operation, if the mutation can be observed by prior async operations.

This requirement asserts that mutation in a child scope can not be propagated to its immutable
caller continuation as well.

The following list shows the underlying language constructs of each OpenTelemetry language SDK:

- JavaScript: OpenTelemetry JS provides both web (`zone.js` based) and Node.js context implementations:
  - [AsyncLocalStorageContextManager](https://github.com/open-telemetry/opentelemetry-js/tree/main/packages/opentelemetry-context-async-hooks).
  - [ZoneContextManager](https://github.com/open-telemetry/opentelemetry-js/tree/main/packages/opentelemetry-context-zone-peer-dep).
- dotnet: OpenTelemetry dotnet provides both [`AsyncLocal`][] based and [`CallContext`][] based context implementations.
  - [OpenTelemetry.Context.AsyncLocalRuntimeContextSlot](https://github.com/open-telemetry/opentelemetry-dotnet/blob/main/src/OpenTelemetry.Api/Context/AsyncLocalRuntimeContextSlot.cs).
  - [OpenTelemetry.Context.RemotingRuntimeContextSlot](https://github.com/open-telemetry/opentelemetry-dotnet/blob/main/src/OpenTelemetry.Api/Context/RemotingRuntimeContextSlot.cs).
- Go: uses [go.context](https://pkg.go.dev/context) directly.
- Python [ContextVarsRuntimeContext](https://github.com/open-telemetry/opentelemetry-python/blob/main/opentelemetry-api/src/opentelemetry/context/contextvars_context.py).
- Ruby [Context](https://github.com/open-telemetry/opentelemetry-ruby/blob/main/api/lib/opentelemetry/context.rb), based on Ruby's [Fiber](#ruby).
- Rust [Context](https://github.com/open-telemetry/opentelemetry-rust/blob/main/opentelemetry/src/context.rs), does not support tokio yet.
- Swift:
  - [ActivityContextManager](https://github.com/open-telemetry/opentelemetry-swift/blob/main/Sources/OpenTelemetryApi/Context/ActivityContextManager.swift).
  - [TaskLocalContextManager](https://github.com/open-telemetry/opentelemetry-swift/blob/main/Sources/OpenTelemetryApi/Context/TaskLocalContextManager.swift).

## JavaScript prior arts

### Node.js AsyncLocalStorage

Node.js provides a stable API [`AsyncLocalStorage`][] that supports implicit context propagation
across `await` and runtime APIs.

```typescript
class AsyncLocalStorage<ValueType> {
  static bind<T extends Function>(fn: T): T;
  static snapshot(): () => void;

  constructor();

  getStore(): ValueType;

  run<T extends Function, ReturnType = GetReturnType<T>>(store: ValueType, callback: T, ...args: never[]): ReturnType;

  /** @experimental */
  enterWith(store: ValueType);
}
```

The `AsyncContext.Variable` is significantly inspired by `AsyncLocalStorage`. However,
`AsyncContext.Variable` only provides an essential subset of `AsyncLocalStorage`,
with a follow-up extension for set semantic with scope enforcement
like `using _ = asyncVar.withValue(val)`, as described in
[mutation-scope.md](./MUTATION-SCOPE.md#the-set-semantic-with-scope-enforcement).

Additionally, as `AsyncContext.Variable` is built in the language, it also
support language constructs like (async) generators.

### zones.js

[`zone.js`][] provides a `Zone` object, which has the following API:

```typescript
class Zone {
  constructor({ name, parent });

  name;
  get parent();

  fork({ name });
  run(callback);
  wrap(callback);

  static get current();
}
```

The concept of the _current zone_, reified as `Zone.current`, is crucial. Both
`run` and `wrap` are designed to manage running the current zone:

- `z.run(callback)` will set the current zone to `z` for the duration of
  `callback`, resetting it to its previous value afterward. This is how you
  "enter" a zone.
- `z.wrap(callback)` produces a new function that essentially performs
  `z.run(callback)` (passing along arguments and this, of course).

The _current zone_ is the async context that propagates with all our operations.
In our above example, sites `(1)` through `(6)` would all have the same value of
`Zone.current`. If a developer had done something like:

```typescript
const loadZone = Zone.current.fork({ name: "loading zone" });
window.onload = loadZone.wrap(e => { ... });
```

then at all those sites, `Zone.current` would be equal to `loadZone`.

Notably, zone.js features like monitoring or intercepting async tasks scheduled in
a zone are not in the scope of this proposal.

## Other JavaScript APIs on async tasks

### Node.js `domain` module

Domain's global central active domain can be consumed by multiple endpoints and
be exchanged in any time with synchronous operation (`domain.enter()`). Since it
is possible that some third party module changed active domain on the fly and
application owner may unaware of such change, this can introduce unexpected
implicit behavior and made domain diagnosis hard.

Check out [Domain Module Postmortem][] for more details.

### Node.js `async_hooks`

This is what the proposal evolved from. `async_hooks` in Node.js enabled async
resources tracking for APM vendors. On which Node.js also implemented
`AsyncLocalStorage`.

### Chrome Async Stack Tagging API

Frameworks can schedule tasks with their own userland queues. In such case, the
stack trace originated from the framework scheduling logic tells only part of
the story.

```console
Error: Call stack
  at someTask (example.js)
  at loop (framework.js)
```

The Chrome [Async Stack Tagging API][] introduces a new console method named
`console.createTask()`. The API signature is as follows:

```typescript
interface Console {
  createTask(name: string): Task;
}

interface Task {
  run<T>(f: () => T): T;
}
```

`console.createTask()` snapshots the call stack into a `Task` record. And each
`Task.run()` restores the saved call stack and append it to newly generated call
stacks.

```console
Error: Call stack
  at someTask (example.js)
  at loop (framework.js)          // <- Task.run
  at async someTask               // <- Async stack appended
  at schedule (framework.js)      // <- console.createTask
  at businessLogic (example.js)
```


[async stack traces]: https://v8.dev/docs/stack-trace-api#async-stack-traces
[async stack tagging api]:
  https://developer.chrome.com/blog/devtools-modern-web-debugging/#linked-stack-traces
[domain module postmortem]: https://nodejs.org/en/docs/guides/domain-postmortem/
[`AsyncLocalStorage`]: https://nodejs.org/docs/latest/api/async_context.html#class-asynclocalstorage
[`AsyncLocal`]: https://learn.microsoft.com/en-us/dotnet/api/system.threading.asynclocal-1?view=net-9.0
[`CallContext`]: https://learn.microsoft.com/en-us/dotnet/api/system.runtime.remoting.messaging.callcontext?view=netframework-4.8.1
[`zone.js`]: https://github.com/angular/angular/tree/main/packages/zone.js
