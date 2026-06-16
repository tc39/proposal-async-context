# AsyncContext propagation with events in the HTML specification

This document goes over the detailed consequence of applying the [event propagation principles](https://github.com/tc39/proposal-async-context/blob/master/WEB-INTEGRATION.md#summary-of-event-propagation-rules) to events defined by the HTML specification.

To summarize the principles:
- APIs that dispatch events synchronously do not change the current async context
- events fired due to JS-external causes (e.g. user interaction) or due to cross-thread JS run in the empty context
- APIs that asynchronously fire events due to a method/setter call, for which the event is fired either on
	- an object created by the method
	- on the object whose method was called, unless it's a singleton (e.g. `document`)

	propagate the context from the method/setter call to the event dispatch
- APIs that react to DOM tree changes (insertion/removal/move of children, ancestors, or attributes) propagate the context from the DOM update to the event fired
- Other API shapes fire events in the empty context

Unless otherwise specified by this document, events that are fired synchronously preserve the existing active AsyncContext, while events that are fired with no JavaScript on the stack are fired in the empty context.

> [!IMPORTANT]
> This document frequently uses wording similar to
> > When X happens, the user agent must:
> > - synchronously capture the current AsyncContext, and store it on the object
> > - use that context to later fire the event triggered by the action
>
> It is possible that X happens multiple times synchronously after each other, which causes multiple contexts to be captured. Each of the fired events must then be fired in the corresponding context.
>
> In practice, the simpler implementation in many of those cases will be to capture the context in the scheduled task(s), rather than actually on the object itself. Another option is to store multiple contexts on the object, with some information to distinguish them when firing the event.

## Section by section
### 4.2.1 - The `style` element
When [updating a `style` block](https://html.spec.whatwg.org/#the-style-element:update-a-style-block), the user agent must:
- synchronously capture the current AsyncContext when one of the conditions to update a `style` block occurs, and store it on the `style` element
- when obtaining the style sheet's critical subresources completes, use that context to fire the `load` or `error` event
### 4.2.4, 4.6.6 - `link` elements of various types 
When [fetching and processing the linked resource](https://html.spec.whatwg.org/#fetch-and-process-the-linked-resource) the user agent must:
- synchronously capture the current AsyncContext at the appropriate times to fetch and process the linked resource, and store it on the `link` element
- use that context to fire the `load` or `error` events on that `link` element
### 4.8.3, 4.8.4 - Images and the `img` element
When an `img` element [is created or has experienced relevant mutations](https://html.spec.whatwg.org/multipage/images.html#when-to-obtain-images), the user agent must:
- synchronously capture the current AsyncContext, and store it on the `img` element
- use that context to fire the `load` or `error` events on that `img` element fired when [updating the image data](https://html.spec.whatwg.org/#update-the-image-data)

When updating an `img` element to [react to changes in the environment](https://html.spec.whatwg.org/#img-environment-changes), the user agent must store an empty AsyncContext to be used to fire the `load` and `error` events.

Note that AsyncContext propagation behaves the same regardless of whether an user agent obtains images immediately or on demand.
### 4.8.5 - The `iframe` element
When [processing the `iframe` attributes](https://html.spec.whatwg.org/#process-the-iframe-attributes), which can happen due to changes to its `src` and `srcdoc` attributes, or due to [it being connected or removed](https://html.spec.whatwg.org/#the-iframe-element:html-element-post-connection-steps), the user agent must:
- synchronously capture the current AsyncContext, and store it on the `iframe` element
- use that context to fire the `load` event on the `iframe` element
> [!WARNING]
   Firefox fires an unspecified `error` event fired: it should be fired in the same context as the `load` event would.

Note that the captured context is not used for events fired inside the `iframe` as a consequence of the navigation, and no context is captured by navigations caused inside the `iframe`.

> [!NOTE]
> **QUESTION:** Does this actually work? The `load` event is fired for all navigations inside the `iframe`, regardless of how they are triggered (e.g. also if inside the iframe it does `location.href = ...`). Can we distinguish what caused the iframe to navigate when the event is fired?

### 16.3.2 - Frames
When [processing the `frame` attributes](https://html.spec.whatwg.org/#process-the-iframe-attributes), which can happen due to changes to its `src` attribute or due to [it being inserted](https://html.spec.whatwg.org/#frames:html-element-insertion-steps), the user agent must:
- synchronously capture the current AsyncContext, and store it on the `frame` element
- use that context to fire the `load` event on the `frame` element

As with `iframe`, the captured context is not used for any event fired *inside* the framed document.

### 4.8.6 - The `embed` element
When an `embed` element [becomes potentially active](https://html.spec.whatwg.org/#concept-embed-active) while there is JavaScript on the stack, or it has it's `src`/`type` attributes set/changed/removed, the user agent must:
- synchronously capture the current AsyncContext, and store it on the `embed` element (and *not* asynchronously in the [`embed` element setup steps](https://html.spec.whatwg.org/#the-embed-element-setup-steps))
- use that context when firing the `load` event in the [`embed` element setup steps](https://html.spec.whatwg.org/#the-embed-element-setup-steps) or in the [completely finish loading a document](https://html.spec.whatwg.org/#completely-finish-loading) steps.

If there is no JavaScript on the stack when the `embed` element [becomes potentially active](https://html.spec.whatwg.org/#concept-embed-active), the captured context is empty.
### 4.8.7 - The `object` element
When one of the conditions that cause the steps to determine what the `object` element represents [to be queued](https://html.spec.whatwg.org/#the-object-element:queue-an-element-task) occur, the user agent must:
- synchronously capture the current AsyncContext, and store it on the `object` element (and *not* asynchronously in the queued steps)
- use that context when firing the corresponding `load` and `error` events fired by the same algorithm

If the condition that occurs is that the element changes between being rendered and not, the captured AsyncContext is empty.
### 4.8.8 - The `video` element
When firing a `resize` event due to the natural width or height of the video changing, use the empty context.
### 4.8.11 - The media elements (shared logic for `video`/`audio`)
Media elements have three different state classes, with event fired during transitions between the various states. These three classes are not independent, and changes in one can affect the others.

> [!NOTE]
> **INFO:** The next four sections go more in details into these states and events, and the last one into how they interact with AsyncContext propagation.
#### The _network_ states
They represent the loading progress of the associated resource, and whether loading is even possible at all. They are exposed as the `.networkState` attribute of the media element.

Loading starts when first adding a `.src` / `.srcset` / `<source>` to the media element, or when manually calling `.load()` on it, and it transitions between `NETWORK_EMPTY` (before the loading process starts or after that it has been aborted), `NETWORK_NO_SOURCE` (when no valid source has been found yet), `NETWORK_LOADING` (when the user agent is actually loading data), and `IDLE` (when the user agent decides to pause loading and then continue later).

When "paused" in the `NO_SOURCE` state, loading can then resume as a reaction to changes in the children list of the media element.

State transitions can trigger different events:
- `loadstart`, when a valid source is found
- `abort` and `emptied`, when the loading process is cancelled
- `suspend`, when the user agent decides it already loaded enough content and wants to wait before loading more
- `error`, when due to an error the source cannot continue loading

While in the `LOADING` state two other events are fired multiple times, `progress` and `stalled`, indicating whether the server is currently sending data or not.

![](./images/network_states.svg)

#### The *ready* states
They represent how much time of the video has been already loaded, potentially in relation to the current time position of the media element. They are exposed as the `.readyState` attribute of the media element.

A video initially starts as `NOTHING`, and then as loading proceeded it transitions to `METADATA` (the video metadata has been loaded), `CURRENT_DATA` (there is enough content loaded to show one frame), `FUTURE_DATA` (there is enough content to play for a little bit) and `ENOUGH_DATA` (there is enough content that the user will probably be able to play the whole media element without buffering).

As the time duration changes (either due to the media element playing, or due to the user seeking around) the ready state can transition *back* to `FUTURE_DATA` or even to `CURRENT_DATA`, potentially leading to the `canplay` and `canplaytrhough` events being later fired again. The `loadedmetadata` and `loadeddata` events are fired at most once, unless the element is fully reset by loading a different source.

![](./images/ready_states.svg)

#### The *playback* states
They represent whether the video is currently playing or paused. These states are not actually exposed as a real enum-based state on the media element, but as separate attributes.

These four states are `PLAYING`/`WAITING` and `PAUSED`/`ENDED`: each pair represents an *intended* state, but which of the two states the media element is actually in depends on the time position and the ready state.

A video can become *potentially playing* by the user clicking the "Play" button, by the `.play()` JavaScript method, or by loading changes if the `autoplay` attribute of the media element is set. When that happens, the `play` event is fired, and then the video will oscillate between the `PLAYING` and `WAITING` states depending on whether there is enough content loaded to play or not. Whenever one of these two states is entered, a corresponding `playing` or `waiting` event is fired. While a video is `PLAYING`, it will fire multiple `timeupdate` events to mark the progress of time.

A video can then be paused, either by the user clicking the "Pause" button, by the `.pause()` JavaScript method, by the media element reaching the end of its playback position with the `loop` attribute not set, or by a video that has been auto played not respecting the autoplay conditions anymore (for example, moving out of the viewport). When this happens, a `pause` event is fired.

When a video reaches the end of the time duration and it's paused, an `ended` event will be fired: this can either happen naturally due to the video playing to its end, or due to seeking to the end.

![](./images/playback_states.svg)

#### Other actions and events

A user agent can be required to *seek* at a new playback position , either through user action, by calling the `.fastSeek()` method, or by setting the `.currentTime` attribute. When this happens, the media element will fire a `seeking` event, a `timeupdate` event, and a `seeked` event. The playback state will continue as it was before seeking, potentially switching immediately after between `PLAYING` end `WAITING`, between `PAUSED` and `ENDED`, or from `PLAYING`/`WAITING` to `ENDED`. 

A media element's default playback rate and playback rate can change, either through user action or by setting the `.defaultPlaybackRate`/`.playbackRate` attributes. When this happens, a `ratechange` event is fired on the media element.

Similarly, its volume can change, either through user action or by setting the `.volume` or `.muted` attributes. When this happens, a `volumechange` event is fired on the media element.
#### AsyncContext propagation

Media elements can expose controls that let the user interact with them, and they behave as if the corresponding JavaScript APIs were called. In those case, the "current AsyncContext" that gets captured is the *empty* context.

Some the events fired on media elements are part of long-lived processes (e.g. loading, or playing), while others are due to an occasional action happening and completing.

There are two possible approaches when it comes to the events fired as part of long-lived processes: one that involves sharing a single AsyncContext snapshot across all of them, and one that separates loading from playing.

> [!NOTE]
> **TODO:** We need to get more feedback from users and browser developers to pick one
##### Option 1: Separate long-lived AsyncContext snapshots
The media element has two slots for storing long-lived AsyncContext snapshots:
- the one for *loading* events, used for:
	- the events related to *network* states (`abort`, `emptied`, `loadstart`, `suspend`, `error`, `progress`, `stalled`)
	- the events related to *ready* states (`loadedmetadata`, `loadeddata`, `canplay`, `canplaythrough`)
	- the `resize` event fired on `video` elements after [fetching enough data to determine its dimensions](https://html.spec.whatwg.org/#getting-media-metadata), and the `durationchange` event fired once the length of the media resource [changed to a known value](https://html.spec.whatwg.org/#durationChange)
- the one for *playing* events, used for:
	- those related to `PLAYING`/`WAITING` *playback* states (`play`, `waiting`, `playing`, `timeupdate`)
	- those related to the `ENDED` *playback* state, if it's reached due to the media resource playing all the way to the end (`pause`, `ended`)

When running the [media element load algorithm](https://html.spec.whatwg.org/#media-element-load-algorithm) or the [resource selection algorithm](https://html.spec.whatwg.org/#concept-media-load-algorithm) due to any of the following:
- changes to the `src`, `currentSrc`, or `srcObject` attributes (this includes creation through the [`new Audio(src)`](https://html.spec.whatwg.org/#dom-audio) constructor or [in other ways](concept-media-load-algorithm-at-creation))
- calling the [`.load()`](https://html.spec.whatwg.org/#dom-media-load) method
- [inserting a `<source>`](https://html.spec.whatwg.org/#the-source-element:html-element-insertion-steps) as a child of the media element
-  [calling `.pause()` on a media element whose network status is `EMPTY`](https://html.spec.whatwg.org/#dom-media-pause)
the user agent must synchronously capture the current AsyncContext and store it on the media element as the context for *loading* events.
> [!NOTE]
> **QUESTION:** Should the `emptied` and `abort` events fire in the new or old loading context?

When running the [`.play()`](https://html.spec.whatwg.org/#dom-media-play) method of media elements, the user agent must synchronously capture the current AsyncContext and store in on the media element as the context for *playing* events.

When running the [resource selection algorithm](https://html.spec.whatwg.org/#concept-media-load-algorithm) due to [playing a media element whose network status is `EMPTY`](https://html.spec.whatwg.org/#internal-play-steps), copy the new context for *playing* events as the context for *loading* events.

When the *ready* state of an element eligible for autoplay [transitions to `ENOUGH_DATA`](https://html.spec.whatwg.org/#ready-states:dom-media-have_enough_data-2),
- if the user agent decides to start playing it, it must copy the context for *loading* events as the context for *playing* events;
- otherwise, if the user agent decides to only play the video once it enters the viewport, it must store the empty context as the context for *playing* events before doing so. 

> [!NOTE]
> **tip:** - When setting a new context for *loading* events, the user agent can unobservably clear all the other contexts stored on the media element.
> - When the media element gets paused, the user agent can unobservably clear the context for *playing* events.
##### Option 2: Single long-lived AsyncContext snapshot
On the media element there is a slot, that we can call *principal AsyncContext snapshot*, which stores an AsyncContext snapshot shared both by events related to *loading* and to *playing*. It behaves the same way as in the [Separate long-lived AsyncContext snapshots](#TODO: Link) section, but the context for *loading* events and the one for *playing* events live share the same slot, overwriting each other following a last-wins approach.
##### Occasional actions
Each occasional action stores its own AsyncContext snapshot on the media element, which can be cleared once the corresponding events are fired.

When the `defaultPlaybackRate` or `playbackRate` attributes [change value](https://html.spec.whatwg.org/#rateUpdate), the user agent must:
- synchronously capture the current AsyncContext (empty if the change is done through user interaction), and store it on the media element as the context for *ratechange* events
- use that context to fire the corresponding `ratechange` event

When the `volume` attribute [changes value](https://html.spec.whatwg.org/#set-the-playback-volume), or when [setting the muted state](https://html.spec.whatwg.org/#set-the-muted-state), the user agent must:
- synchronously capture the current AsyncContext (empty if the change is done through user interaction), and store it on the media element as the context for *volumechange* events
- use that context to fire the corresponding `volumechange` event

When [pausing](https://html.spec.whatwg.org/#dom-media-pause), the user agent must:
- if pausing [due to viewport changes](https://html.spec.whatwg.org/#ready-states:internal-pause-steps) or due to user interaction with the element, store the empty context on the media element as the context for *pausing* events
- otherwise, if pausing due to the [media element being removed from the DOM tree](https://html.spec.whatwg.org/#playing-the-media-resource:internal-pause-steps-2) or because the `volume` attribute [changes value](https://html.spec.whatwg.org/#set-the-playback-volume), synchronously capture the current AsyncContext and store it on the media element as the context for *pausing* events
- otherwise, if pausing due to the [playing the media resource to the end](https://html.spec.whatwg.org/#playing-the-media-resource:current-playback-position-4), copy the media element's context for *playing* events as the context for *pausing* events
- the user agent must then use this "context for *pausing* events" for the corresponding `pause` event. If pausing due to the media element playing to the end, also use it for the `ended` event.

> [!NOTE]
> **INFO:** While the algorithm for pausing will fire a `timeupdate` event to notify the consumers of the final time reached by the media resource, that event will still be fired with the context for *playing* event, as it is conceptually the last event that happens as part of the playthrough process.

When [seeking](https://html.spec.whatwg.org/#seeking), the user agent must:
- if seeking due to any of the following reasons:
	- the media element's [default playback start position](https://html.spec.whatwg.org/#loading-the-media-resource:dom-media-seek)
	- an [initial position indicated by the resource/URL itself](https://html.spec.whatwg.org/#loading-the-media-resource:dom-media-seek-2)
	-  [changes in the earliest possible position](offsets-into-the-media-resource:earliest-possible-position-4)
	- the duration [changing to a smaller value than the current playback position](https://html.spec.whatwg.org/#offsets-into-the-media-resource:dom-media-seek-3)
	then copy the media element's context for *loading* events as the context for *seeking* events
- otherwise, if seeking due to any of the following reasons:
	- [reaching the end of a media resource](https://html.spec.whatwg.org/#playing-the-media-resource:current-playback-position-4) whose `loop` attribute is set
	- running the [`play()`](https://html.spec.whatwg.org/#internal-play-steps) method on the media element whose playback has ended (after capturing the context for *playing* events)
	then copy the media element's context for *playing* events as the context for *seeking* events
- otherwise, if seeking due to any of the following reasons:
	- [setting the `.currentTime` attribute](https://html.spec.whatwg.org/#offsets-into-the-media-resource:dom-media-seek) through JavaScript
	- calling the [`.fastSeek()`](https://html.spec.whatwg.org/#dom-media-fastseek) method
	then capture the current AsyncContext and store it on the media element as the context for *seeking* events
- otherwise, if seeking due to any of the following reasons:
	- the media resource is internally scripted or interactive
	- the user seeks around through interaction with the media element
	then store the empty context on the media element as the context for *seeking* events
- the user agent must then use this "context for *seeking* events" to fire the corresponding `seeking`, `timeupdate`, and `seeked` events. If the media element was already paused before seeking and it seeks to the end, use this "context for *seeking* events" also to fire the corresponding `ended` event.

A new seeking process can start while one is in progress: the new one will cancel any pending logic related to the first seek, and will overwrite the stored context for *seeking* events.

Seeking to the end of a media resource that is potentially playing will effectively also fire `paused` and `ended` events. These events will be fired in the context for *playing* events, which is the same as what would happen if seeking just one nanosecond before the end and then letting the media resource play to completion.
##### Events fired on other objects
When the [resource selection algorithm](https://html.spec.whatwg.org/#concept-media-load-algorithm) running for a given media element fires an `error` event on one of its `<source>` children, the user agent must use the empty context.

When the [media data processing steps](https://html.spec.whatwg.org/#media-data-processing-steps-list) running for a given media element fire an `addtrack`, `removetrack`, or `change` event on the media element's `audioTracks` or `videoTracks` lists, the user agent must use the empty context.

When any of the following:
- the [steps to expose a media-resource-specific text track](html.spec.whatwg.org/#steps-to-expose-a-media-resource-specific-text-track) running for a given media element
- the [steps when a `<track>` element's parent changes](https://html.spec.whatwg.org/#sourcing-out-of-band-text-tracks:the-track-element-2)
- the [`.addTextTrack()` method](https://html.spec.whatwg.org/#dom-media-addtexttrack) of a media element 
fire `addtrack` or `removetrack` events on the media element's `textTracks` list, the user agent must use the empty context.

When the [time marches on](https://html.spec.whatwg.org/#time-marches-on) steps running for a given media element fire `enter` or `exit` events on `TextTrackCue` objects, or `cuechange` events on `TextTrack` objects and `<track>` elements, the user agent must use the empty context.

When an [`AudioTrack` or `VideoTrack` is enabled or disabled](https://html.spec.whatwg.org/#toggle-audio-track) and it fires a `change` event on the relevant `AudioTrackList` or `VideoTrackList` object, the user agent must use the empty context.

When a [`TextTrack`'s mode changes](html.spec.whatwg.org/#text-track-model:text-track-16) and it fires a `change` event on the relevant `TextTrackList` object, the user agent must use the empty context.

> [!NOTE]
> **TODO:** We are using the *empty* context for the events above because they are fired on a separate object from the media element one. We could consider an exception to the principles here, and use the stored context for *loading*/*playing* events instead (maybe not for all of those events, but e.g. for the ones fired on DOM elements).

When [starting the `track` processing model](https://html.spec.whatwg.org/#start-the-track-processing-model) due to the element being created, its `mode` changing, or its parent element changing, the user agent must:
- synchronously capture the current AsyncContext, and store it on the `track` element
- use that context to fire the `error` and `load` events on the `track` element
### 4.10.5 , 4.10.7, 4.10.11 - The `input`, `select`, and `textarea` elements

Several of the events fired on `input` elements are fired by the [input activation behavior](https://html.spec.whatwg.org/#input-activation-behavior), which is invoked from the `input` element's [activation behavior](https://html.spec.whatwg.org/#the-input-element). Activation behavior runs *synchronously* as part of dispatching a `click` event, and thus is transparent to AsyncContext: no capturing or storing is needed, and the listeners observe whatever context was active when the `click` dispatch started. Concretely:
- when the `click` event is dispatched due to user action, the activation behavior runs in the empty context;
- when the `click` event is dispatched through  [`el.click()`](https://html.spec.whatwg.org/#dom-click), `el.dispatchEvent(new MouseEvent("click"))`, or via `label.click()` on a label for the `input` element, the activation behavior runs in the synchronous caller's context.

When [showing a picker, if applicable](https://html.spec.whatwg.org/#common-input-element-apis), the user agent must:
- synchronously capture the current AsyncContext, and store it on the `input` element;
- when reacting to relevant interactions in the picker user interface, use the stored context to fire `input`, `change`, or `cancel` events (this includes the events fired by `type=file`'s [update the file selection](https://html.spec.whatwg.org/#file-upload-state-(type=file):input-activation-behavior) steps)

> [!INFO] 
> [Showing a picker, if applicable](https://html.spec.whatwg.org/#common-input-element-apis) on `input` A may close currently a previously opened picker on `input` B: the `input`, `change`, or `cancel` events fired on `input` B will use the context that was captured when such picker was shown.

For `input` elements without a defined [input activation behavior](https://html.spec.whatwg.org/#input-activation-behavior), the user agent must use the empty context when firing `input` and `change` events in response to user interaction happening outside of the picker.

When [setting the selection range](https://html.spec.whatwg.org/#set-the-selection-range) of an `input` or `textarea` element, the user agent must:
- synchronously capture the current AsyncContext, and store it on the `input` or `textarea` element;
- use the stored context to fire the corresponding `select` event.

When the user [changes the current selection](https://html.spec.whatwg.org/#the-input-element-as-a-text-entry-widget:event-select) of an `input` or `textarea` element, the user agent must fire the corresponding `select` event in the empty context.
#### Propagation with specific `input` types
##### 4.10.5.1.2 - `type=text` and `type=search`
When a user [changes the writing direction](https://html.spec.whatwg.org/#text-(type=text)-state-and-search-state-(type=search)) of a `type=text` or `type=search` element, the user agent must fire the `input` event using the empty context.
##### 4.10.5.1.15, 4.10.5.1.16 - `type=checkbox` and `type=radio`
The `input` and `change` events are fired synchronously as part of the input activation behavior, thus it is transparent to AsyncContext.
##### 4.10.5.1.19 - `type=image`
When a any of the conditions that cause the image to be fetched, the user agent must:
- synchronously capture the current AsyncContext, and store it on the `input` element
- use that context to fire the `load` or `error` events on that `input` element fired in the [`processResponseEndOfBody`](https://html.spec.whatwg.org/#image-button-state-(type=image):processresponseendofbody) steps
#### Propagation for `select` elements
When [sending `select` update notifications](https://html.spec.whatwg.org/#send-select-update-notifications) fires the `input` and `change` events, the user agent must use the empty context (they are only ever fired as a consequence of user interaction).
#### Propagation for `textarea` elements
When a user [causes the element's raw value to change](html.spec.whatwg.org/#the-textarea-element:concept-textarea-raw-value-3) or [changes its the writing direction](html.spec.whatwg.org/#the-textarea-element:concept-event-fire-2), the user agent must fire the `input` event using the empty context.
### 4.10.6 - The `button` element
The `command` event fired as part of a `button` element's [activation behavior](https://html.spec.whatwg.org/#the-button-element:activation-behaviour) is fired synchronously and thus is transparent to AsyncContext. This means that if it is caused by JavaScript it will have JavaScript on the stack and preserve its context; if it is caused by user interaction it will be fired in an empty context.
### 4.10.21, 4.10.22, 4.10.23 - Constraints and form submission
All the following events are fired synchronously and thus transparent to AsyncContext:
- the `invalid` event fired by an element's [check validity steps](https://html.spec.whatwg.org/#check-validity-steps) or [report validity steps](https://html.spec.whatwg.org/#report-validity-steps), or while [statically validating the constraints](https://html.spec.whatwg.org/#statically-validate-the-constraints) of a `form` element;
- the `formdata` event fired when [constructing the entry list of a form](https://html.spec.whatwg.org/#constructing-the-form-data-set)  due to it being [submitted](https://html.spec.whatwg.org/#concept-form-submit) or due to `XMLHttpRequest`'s [`new FormData(form)`](https://xhr.spec.whatwg.org/#dom-formdata) constructor;
- the `submit` event fired while [submitting](https://html.spec.whatwg.org/#concept-form-submit) a form;
- the `reset` event fired while [resetting](https://html.spec.whatwg.org/#concept-form-reset) a form.

This means that if they are caused by JavaScript they will have JavaScript on the stack and preserve its context; if they are caused by user interaction they will be fired in an empty context.
### 4.11.1 - The `details` element
When the [`open` attribute changes](https://html.spec.whatwg.org/#the-details-element:concept-element-attributes-change-ext) on a `details` element, the user agent must:
- synchronously capture the current AsyncContext, and store it on the `details` element together with the [details toggle task tracker](https://html.spec.whatwg.org/#details-toggle-task-tracker)
- use that context to fire the `toggle` event from the queued task, and then clear it together with the tracker

> [!NOTE]
> **INFO:** When the `open` attribute changes multiple times before that the `toggle` event is fired, the final event will fire with the context of the last attribute change.

> [!NOTE]
> **INFO:** When changing a `details` element's `name` attribute, its `open` attribute might synchronously change too (if it is open and joins a group with an already open element), causing the steps above to run.
### 4.11.3 - Commands
Commands synchronously trigger some behaviour on an element: at that point the element will potentially capture the context, as if the behaviour was triggered on the element in other ways.
### 4.11.4 - The `dialog` element
The `beforetoggle` event is fired synchronously by either [`.show()`](https://html.spec.whatwg.org/#dom-dialog-show), by the [show a modal dialog](https://html.spec.whatwg.org/#show-a-modal-dialog) steps (which are in turn invoked synchronously by either [`.showModal()`](https://html.spec.whatwg.org/#the-dialog-element:command-steps) or by its [command steps](https://html.spec.whatwg.org/#the-dialog-element:command-steps)),  or when [closing](https://html.spec.whatwg.org/#close-the-dialog) it: it is thus transparent to AsyncContext.

When [queuing a dialog toggle event task](https://html.spec.whatwg.org/#queue-a-dialog-toggle-event-task), which is done synchronously by either [`.show()`](https://html.spec.whatwg.org/#dom-dialog-show), by the [show a modal dialog](https://html.spec.whatwg.org/#show-a-modal-dialog) steps, the user agent must:
- synchronously capture the current AsyncContext, and store it on the `details` element together with the [dialog toggle task tracker](https://html.spec.whatwg.org/#dialog-toggle-task-tracker)
- use that context to fire the `toggle` event from the queued task, and then clear it together with the tracker

> [!NOTE]
> **INFO:** Like for the `details` element, when a dialog is toggle multiple times before that `toggle` is fired, the final event will fire with the context of the last attribute change.

When [closing](https://html.spec.whatwg.org/#close-the-dialog) a dialog, the user agent must:
- synchronously capture the current AsyncContext, and store it on the `dialog` element
- use that context to fire both for the `toggle` event (done by [queuing a dialog toggle event task](https://html.spec.whatwg.org/#queue-a-dialog-toggle-event-task)) and for the corresponding `close` event

The `cancel` event is fired synchronously by the dialog's close watcher [cancel action](https://html.spec.whatwg.org/#canceling-dialogs), which is either run synchronously by [`.requestClose()`](https://html.spec.whatwg.org/#dom-dialog-requestclose) or as a consequence of user interaction: it is thus transparent to AsyncContext.
### 4.12.1 - The `script` element
The `script` element processing model starts from the [prepare the script element](https://html.spec.whatwg.org/#prepare-the-script-element) algorithm, which is run synchronously in response to DOM changes.

When [preparing the script element](https://html.spec.whatwg.org/#prepare-the-script-element) for a `script` that has a `src` attribute, user agents must:
- synchronously capture the current AsyncContext, and store it on the `script` element
- use that context to fire the corresponding `load` and `error` events, including those fired while [executing the script element](https://html.spec.whatwg.org/#execute-the-script-element).

> [!NOTE]
> **TODO:** ECMAScript modules un run in the empty context, to avoid exposing which of the importers actually caused its execution. Classic scripts do not have the same "raciness": it's do be settled whether we should hide the context, or just let it be present. For synchronous scripts it would be present by default, but we'd need to wire it through for async/deferred ones.

### 4.12 - Custom elements

> [!TODO]
### 6.1 - The `hidden` attribute
The `beforematch` event fired by the [ancestor revealing algorithm](https://html.spec.whatwg.org/#ancestor-revealing-algorithm) is transparent to AsyncContext, because it's fired on separate objects from the one that caused it to happen, thus:
- runs in the empty context when fired due to user interaction, such us through [find-in-page](https://html.spec.whatwg.org/#find-in-page) or clicking on a link to a fragment
- runs in the existing AsyncContext when fired synchronously with JavaScript on the stack, such as when setting `location.href` or calling `.click()` on a link to navigate to a specific anchor
### 6.2 - Page visibility
The `visibilitychange` event fired by the [update the visibility state](https://html.spec.whatwg.org/#update-the-visibility-state) algorithm is transparent to AsyncContext, because it's fired on a separate object (`document`) from the ones that can cause it to happen. Effectively it always runs in the empty context, as there are no JavaScript APIs that cause it to be fired synchronously.
### 6.5, 6.6 - Clicking and focusing
The [`.click()`](https://html.spec.whatwg.org/multipage/interaction.html#dom-click) method synchronously dispatches the `click` event, which in turn causes the element's activation behavior to happen. As this is all synchronous, there is no special handling of AsyncContext needed.

Similarly, most the logic related to focusing runs either synchronously or due to user interaction, and thus the relative `change`/`blur`/`focus` events are transparent to AsyncContext.

When [an element with the `autofocus` attribute is inserted](https://html.spec.whatwg.org/#the-autofocus-attribute:insert-an-element-into-a-document), the user agent must:
- synchronously capture the current AsyncContext, and store it together with the element in the list of autofocus candidates
- when focusing the element as part of [flushing autofocus candidates](https://html.spec.whatwg.org/#flush-autofocus-candidates), it must use that context to fire the `change`/`blur`/`focus` events

When the [window event loop](https://html.spec.whatwg.org/#event-loop-processing-model:window-event-loop-3) [moves the focus to the document's viewport](https://html.spec.whatwg.org/#event-loop-processing-model:focused-area-of-the-document), it must fire the relevant `change`/`blur`/`focus` events using the empty context.
### 6.10 - Close requests and close watchers
The `cancel` and `close` events are fired on `CloseWatcher` instances either synchronously or through user interaction, and are thus transparent to AsyncContext.
### 6.11 - Drag and drop

Drag and drop events (`dragstart`, `drag`, `dragenter`, `dragleave`, `dragover`, `drop`, `dragend`) are fired due to user interaction, and thus run in the empty context.

> [!NOTE]
> **INFO:** When looking for these events in the spec, search for *fire a DND event*.
### 6.12 - The `popover` attribute
[Showing a popover](https://html.spec.whatwg.org/#show-popover) and [hiding a popover](https://html.spec.whatwg.org/#hide-popover-algorithm)  synchronously fire a `beforetoggle` event and are run either synchronously from JavaScript code or due to user interaction, it is thus transparent to AsyncContext.

When [queueing a popover toggle event task](https://html.spec.whatwg.org/#queue-a-popover-toggle-event-task), which is done synchronously either when [showing a popover](https://html.spec.whatwg.org/#show-popover) and [hiding a popover](https://html.spec.whatwg.org/#hide-popover-algorithm), the user agent must:
- synchronously capture the current AsyncContext, and store it on the element together with the [popover toggle task tracker](https://html.spec.whatwg.org/#popover-toggle-task-tracker)
- use that context to fire the `toggle` event from the queued task, and then clear it together with the tracker

> [!NOTE]
> **INFO:** Like for the `dialog` and `details` elements, when a popover is toggle multiple times before that `toggle` is fired, the final event will fire with the context of the last attribute change.
### 7.2.2 - The `Window` object

> [!NOTE]
> **TODO:** Probably everything on Window is just transparent as it's a singleton, and there is no further handling. If we removed the singleton restriction, `print()` would also propagate when deferred.
### 7.2, 7.4, 7.5 - Navigation and session history, and related APIs
No events are fired on the `window.location` and `window.history` objects themselves. Methods and setters on those interfaces are thus transparent to AsyncContext, with no ad-hoc propagation: event handlers for events fired with JavaScript on the stack will see the current context from the stack, while the others will run in the empty context.

The `window.navigation` object has:
-  [`.navigate()`](https://html.spec.whatwg.org/#dom-navigation-navigate), [`.reload()`](https://html.spec.whatwg.org/#dom-navigation-reload) and [`.updateCurrentEntry()`](https://html.spec.whatwg.org/#dom-navigation-updatecurrententry) methods, which synchronously fire `navigate`/`currententrychange` events.
- [`.traverseTo()`](https://html.spec.whatwg.org/#dom-navigation-traverseto), [`.back()`](https://html.spec.whatwg.org/#dom-navigation-back), and [`.forward()`](https://html.spec.whatwg.org/#dom-navigation-forward) methods, which asynchronously fire `navigate` events, on one or more `navigation` objects (which could be the same one, or ones from another documents/frame).
and they then asynchronously fire `navigatesuccess`/`navigateerror` events.

As `window.navigation` is a global singleton, it has no ad-hoc propagation of AsyncContext: event listeners that run synchronously can see the current context from the JavaScript stack, while asynchronous one will run in the empty context.

> [!NOTE]
> **TODO:** If we drop the *"no propagation on global singletons"* rule, the various `window.navigation` methods should propagate the context to same-document `navigation` events, as well as to `navigatesuccess` and `navigateerror`.
> 
> Alternatively, in the future we could expose a `navigationEvent.asyncContextSnapshot` property for tracing libraries that instrument the `navigate` event directly to be able to detect why a given navigation happened. 

As part of navigation there are multiple events fired on the global `window` object: `hashchange`, `popstate`, `beforeunload`, `pageswap`, `pagereveal`, `pageshow`, `pagehide`, `unload`. There is no ad-hoc propagation for those events, as they both are fired on a global singleton object and on a separate object from the one that causes them.
### 8.1 - Scripting

When [reporting an exception](https://html.spec.whatwg.org/#report-an-exception), the user agent must fire the `error` event in the empty context. Note that it must be explicitly overwritten and it would not always happen by default, as it can be triggered synchronously.

When [notifying about rejected promises](https://html.spec.whatwg.org/#notify-about-rejected-promises), the user agent must fire the `unhandledrejection` event in the empty context.

When running the [`HostPromiseRejectionTracker`](https://html.spec.whatwg.org/#the-hostpromiserejectiontracker-implementation) algorithm, the user agent must fire the `rejectionhandled` event in the empty context.

> [!NOTE]
> **TODO:** Which context is the most useful on errors is still under discussion, but it will likely not be the one that is available by default. The plan is to expose it as a property of the `ErrorEvent` and `PromiseRejectionEvent` interfaces.

Unless otherwise specified, the user agent must fire events fired by the [window event loop](https://html.spec.whatwg.org/#event-loop-processing-model:window-event-loop-3) (such us `contextlost` and `contextrestored` on canvases) in the empty context.
### 8.9.2 - Printing

The [printing steps](https://html.spec.whatwg.org/#printing-steps) are transparent to AsyncContext when firing `beforeprint` or `afterprint` events, as `window` is a global singleton. This means that:
- when printing is initiated by the user, they are fired in the empty context
- when printing is initiated synchronously by [`window.print()`](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#dom-print), event listeners can access the current AsyncContext that is available on the JavaScript stack
- when printing is initiated asynchronously by [`window.print()`](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#dom-print), they are fired in the empty context.

> [!NOTE]
> **QUESTION:** We might want to make an exception here, and make `window.print()` always propagate so that it is internally consistent?
### 8.10 - System state and capabilities
All events fired in this section (`languagechange`, `offline`, `online`) are fired due to external causes on the `window` object. The user agent must fire then in the empty context.
### 9.2 - Server-sent events
When running the [`EventSource()` constructor](https://html.spec.whatwg.org/#dom-eventsource), the user agent must:
- synchronously capture the current AsyncContext, and store it on the `EventSource` object
- use that context to fire the `open` and `error` events queued by [announce the connection](https://html.spec.whatwg.org/#announce-the-connection), [reestablish the connection](https://html.spec.whatwg.org/#reestablish-the-connection), and [fail the connection](https://html.spec.whatwg.org/#fail-the-connection)

When [dispatching a `MessageEvent` event](https://html.spec.whatwg.org/#event-loop-processing-model:window-event-loop-3), the user agent must use the empty context.

> [!NOTE]
> **TODO:** There are two other alternatives to explore:
> - the context is only preserved for the initial `open`/`error` events, as connection drops and re-connections are due to external circumstances and not caused by the constructor itself; this would allow not keeping the context alive for the whole lifetime of the `EventSource` object.
> - the context is propagated to _all_ events on `EventSource`, even those caused by server-sent events
### 9.3 - Cross-document messaging
When running the [window post message steps](https://html.spec.whatwg.org/#event-loop-processing-model:window-event-loop-3), the user agent must fire `message` and `messageerror` events in the empty context.
### 9.4 - Channel messaging
When [disentangling](https://html.spec.whatwg.org/#event-loop-processing-model:window-event-loop-3) two `MessagePort`s, the user agent must fire the `close` event in the empty context.

When running the [message port post message steps](https://html.spec.whatwg.org/#event-loop-processing-model:window-event-loop-3), the user agent must fire `message` and `messageerror` events in the empty context.

> [!NOTE]
> **INFO:** There is no context propagation for `MessagePort` events even within the same realm, because all events fired on one `MessagePort` object are asynchronously caused by actions on the _other_ `MessagePort` object.
> 
> It has been suggested that, in the case of two ports that have not been transferred yet, the context should still be propagated. The motivation is that it would make popular `setImmediate` "polyfills" (like the one used by the React scheduler, or by other popular scheduling libraries on npm) automatically preserve the context without changes needed on their side. For the time being we are excluding this option, as the code changes required in such scheduling libraries are minimal.
### 9.5 - Broadcasting to other browsing contexts
When running a `BroadcastChannel`'s [`.postMessage()`](https://html.spec.whatwg.org/#event-loop-processing-model:window-event-loop-3) method, the user agent must fire the `message` and `messageerror` events in the empty context.

> [!NOTE]
> **INFO:** There is no context propagation for `BroadcastChannel` events even within two channels in the same realm, because all events fired on one `BroadcstChannel` object are asynchronously caused by actions on the _other_ `BroadcstChannel` object.
### 10.2.4, 10.2.6.3, 10.2.6.4 - Workers
When running the [`Worker()`](https://html.spec.whatwg.org/#dom-worker) and [`SharedWorker()`](https://html.spec.whatwg.org/#dom-sharedworker) constructors, the user agent must:
- synchronously capture the current AsyncContext, and store it on the created object
- use that context to fire the `error` event fired when starting to [run a worker](https://html.spec.whatwg.org/#run-a-worker) due to [errors while loading or parsing](https://html.spec.whatwg.org/#worker-processing-model:concept-event-fire) the script, when it's a [`SharedWorker` with mismatched options](https://html.spec.whatwg.org/#shared-workers-and-the-sharedworker-interface:concept-event-fire), or when it's a [`SharedWorker` with mismatched secure context](https://html.spec.whatwg.org/#shared-workers-and-the-sharedworker-interface:concept-event-fire-2).

When [running a worker](https://html.spec.whatwg.org/#worker-processing-model:event-workerglobalscope-connect) that is a `SharedWorker`, or when [connecting to an existing one](https://html.spec.whatwg.org/#shared-workers-and-the-sharedworker-interface:concept-event-fire-3), the user agent must fire the `connect` event on the worker global object event in the empty context.

When invoking a `Worker`'s [`.postMessage()`](https://html.spec.whatwg.org/#dom-worker-postmessage) method, the user agent must fire the `message` and `messageerror` events on the worker global object in the empty context.
### 12.2.1 - The `Storage` interface
When [broadcasting](https://html.spec.whatwg.org/#shared-workers-and-the-sharedworker-interface:concept-event-fire-3) a `Storage` object, the user agent must fire the `storage` event on the remote storages in the empty context.
### 13.2.7 - The end (Parsing HTML documents)
When the user agent [stops parsing](https://html.spec.whatwg.org/#stop-parsing) a document, it must fire the `DOMContentLoaded`, `load` and `pageshow` events in the empty context. Note that this is happens automatically, as there is no JavaScript on the stack.

> [!NOTE]
> **TODO:** If we drop the *"no propagation on global singletons"* rule, when the document stops parsing due to a [`document.close()`](https://html.spec.whatwg.org/#dom-document-close) call, the context should be propagated from there.  Similar changes would be needed when [opening the input stream](https://html.spec.whatwg.org/#frames:html-element-insertion-steps).
