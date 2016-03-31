# Using zones to solve complex use cases

As noted in the readme, zones are a base-level primitive that by themselves do not solve many use cases. Here we show examples of how host environments could be minimally extended to take advantage of the association zones create between functions and zones in order to solve some of the more complex use cases.

## Error handling

### Bare-bones solution

A host environment would, in its [HostReportErrors](https://tc39.github.io/ecma262/#sec-host-report-errors) implementation, look up the current Realm Record's [[Zone]], and pass that along to whatever developer-defined error handler is in play. For example, HTML could extend the `ErrorEvent` interface with a `zone` property.

This very minimal extension to the host environment would allow developers to cobble together their own solution for scoping error handling to a particular zone:

```js
const loadZone = Zone.current.fork({ name: "loading zone" });
loadZone.handleError = err => {
    console.error("Error loading!", err);
    sendErrorToServer(err);
};

window.onload = loadZone.wrap(e => { ... });

const clickZone = Zone.current.fork({ name: "clicking zone" });
clickZone.handleError = err => {
    showDialog({ title: "Could not do the thing!", message: err.message });
};

button.onclick = clickZone.wrap(e => { ... });

// Here's the magic:
window.addEventListener("error", e => {
    if (e.zone.handleError) {
        e.zone.handleError(e.error);
        e.preventDefault();
    }
});
```

(The same sort of thing can be done for unhandled promise rejections, of course.)

### More full-featured solution

In this variation, a host environment bakes in a convention for creating zones with specific error handlers. This has a number of advantages. Among them:

- It avoids requiring developers to agree on a convention (the name `handleError` above) and all use it consistently.
- It allows error handlers to be set at zone creation time, and stay immutable, instead of using expando properties.

In this variation, the host environment defines HostSetupZone roughly as follows:

1. Let _handleError_ be ? GetV(_options_, `"handleError"`).
1. If _handleError_ is not *undefined*, and IsCallable(_handleError_) is **false**, throw a **TypeError** exception.
1. Set the value of _zone_'s [[HostDefined]] internal slot to Record { [[HandleError]]: _handleError_ }.

Then, the host defines its implementation of [HostReportErrors](https://tc39.github.io/ecma262/#sec-host-report-errors) similarly to our developer-created `"error"` handler above:

1. Let _currentZone_ be the value of the current Realm Record's [[Zone]] field.
1. Let _zoneErrorHandler_ be the value of _currentZone_'s [[HostDefined]] internal slot's value's [[HandleError]] field.
1. If _zoneHandleError_ is not **undefined**, then for each element _e_ of _errorList_, perform ? Call(_zoneErrorHandler_, **undefined**, « _e_ »).
1. Otherwise, ( ... perform the default error handling behavior as in the host's existing definition ... ).

## Zone-local storage

Zone-local storage is the idea of making certain "dynamically scoped" variables available to all code inside the same zone.

### Simple solution

The simplest way to accomplish this is with simple expando properties on the zone:

```js
http.createServer((req, res) => {
  const requestZone = Zone.current.fork({ name: `request zone for ${req.url} at time ${Date.now()}` });
  requestZone.req = req;
  requestZone.res = res;

  requestZone.run(() => router.handleRequest());
});

// elsewhere, deep inside async actions resulting from handling the request:
const { res, req } = Zone.current;
res.writeHead(200, { "Content-Type": "text/plain" });
res.end(`request URL was ${req.url}`);
```

### Delegating upward

A more structured version of zone-local storage tries to impose these two properties:

- The stored variables are immutable, with their values set at zone creation time and not modified in the future. (Mutability can be achieved by storing, e.g., a `Map` or a mutable object inside a well-known key.)
- Variable lookup goes up the zone chain, when nested zones are present.

To accomplish this, we build a subclass of `Zone` that takes care of these details for us:

```js
const zoneProps = new WeakMap();

class ZoneWithStorage extends Zone {
  constructor(options, props = Object.create(null)) {
    super(options);
    zoneProps.set(this, Object.assign({}, props));
  }

  get(key) {
    const props = zoneProps.get(this);

    if (key in props) {
      return props[key];
    }

    if (this.parent instanceof ZoneWithStorage) {
      return this.parent.get(key);
    }
  }

  // maybe implement has(key) too if you want.
}
```

We can then use it like so:

```js
http.createServer((req, res) => {
  const requestZone = new ZoneWithStorage(
    {
      parent: Zone.current,
      name: `request zone for ${req.url} at time ${Date.now()}`
    },
    { req, res }
  );

  requestZone.run(() => router.handleRequest());
});

// elsewhere, deep inside async actions resulting from handling the request:
const [res, req] = [Zone.current.get("res"), Zone.current.get("req")];
res.writeHead(200, { "Content-Type": "text/plain" });
res.end(`request URL was ${req.url}`);
```

## Timer counting

There are many complex use cases around how to use zones in the context of scheduling. A solution that is sufficiently general to solve all of them, and yet sufficiently restricted to avoid adding complexity to all scheduled operations, will take us some time to sort through. In the meantime, we'll give a simple illustrative example of the sort of thing zones could do in this area. Please don't take it too seriously!

Our very specific use case here is to monitor the number of outstanding timer tasks, i.e. `setTimeout` and `setInterval`, scheduled within the current zone. When this number changes, we can notify the zone. This could be used by a UI framework to ensure that all timers that are spawned from within an event handler have completed their work, before the framework goes through the work of updating the DOM.

As a rough example of how this might work, consider the following:

```js
// # Framework code

framework.addEventListener = (element, eventName, handler) => {
  element.addEventListener(eventName, e => {
    const eventZone = Zone.current.fork({
      name: `event handler for ${eventName} (element ID ${element.id})`,
      outstandingTimersChanged(numTimers) {
        if (numTimers === 0) {
          synchronizeModelsWithViews();
        }
      }
    });

    eventZone.run(() => eventHandler(e));
  });
};

function synchronizeModelsWithViews() {
  // All "models" that the framework knows about should be diffed since their last
  // sync, with their changes reflected in the "view" (i.e. DOM).
}

// # Web developer code

framework.addEventListener(myButton, "click", () => {
  setTimeout(() => {
    myModel.proposalName = "Zones";
    setTimeout(() => {
      myModel.status = "Stage 0";
    }, 50);
  }, 100);
});
```

This code would ensure that `synchronizeModelsWithViews` only happens after 150 milliseconds have passed, i.e. after all asynchronous (timer-related) work spawned from the event handler has finished. The framework uses this as a sign that things have settled down enough that it's time to take the potentially-expensive step of serializing the model state to the DOM.

As noted, this is just an illustrative example. A more robust solution would need to account for more than just timers (more flexibility), and might be able to reduce the number of calls from the browser into framework code by e.g. calling back only when the count reaches zero (less power). But hopefully it gives you the idea!

Accomplishing this is not very difficult with zones. Our HostSetupZone definition is:

1. Let _outstandingTimersChanged_ be ? GetV(_options_, `"outstandingTimersChanged"`).
1. If _outstandingTimersChanged_ is not *undefined*, and IsCallable(_outstandingTimersChanged_) is **false**, throw a **TypeError** exception.
1. Set the value of _zone_'s [[HostDefined]] internal slot to Record { [[OutstandingTimersChanged]]: _outstandingTimersChanged_, [[OutstandingTimersCount]]: 0 }.

We also define ChangeOutstandingTimersCount(_delta_) as follows:

1. Let _currentZone_ be the current Realm Record's [[CurrentZone]] field.
1. Let _outstandingTimersChanged_ be the value of _currentZone_'s [[HostDefined]] internal slot's [[OutstandingTimersChanged]] field.
1. If _outstandingTimersChanged_ is **undefined**, return.
1. Let _currentCount_ be the value of _currentZone_'s [[HostDefined]] internal slot's [[OutstandingTimersCount]] field.
1. Set the value of _currentZone_'s [[HostDefined]] internal slot's [[OutstandingTimersCount]] field to _currentCount_ + _delta_.
1. Queue a microtask perform the following steps:
  1. Let _newCount_ be the value of _currentZone_'s [[HostDefined]] internal slot's [[OutstandingTimersCount]] field. (NOTE: this could have changed and might not be _currentCount_ + _delta_ anymore.)
  1. Invoke _outstandingTimersChanged_ with **undefined** this value and an arguments list containing the number _newCount_.

We then modify:

- `setTimeout` and `setInterval` to call ChangeOutstandingTimersCount(+1) on invocation
- `setTimeout`'s queued task to to call ChangeOutstandingTimersCount(-1) once the task finishes
- `clearTimeout` and `clearInterval` to call ChangeOutstandingTimersCount(-1) when they actually clear a timer
