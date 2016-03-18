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
