# @marianmeres/batch

[![JSR](https://jsr.io/badges/@marianmeres/batch)](https://jsr.io/@marianmeres/batch)
[![NPM](https://img.shields.io/npm/v/@marianmeres/batch)](https://www.npmjs.com/package/@marianmeres/batch)

A lightweight, generic batch processor that collects items and flushes them based on
configurable triggers.

## Features

- **Interval mode** - flush at fixed time intervals
- **Amount mode** - flush when item count reaches threshold
- **Combined mode** - flush on whichever trigger fires first
- **Safety cap** - prevents unbounded memory growth (with visibility via `droppedCount` / `onDrop`)
- **Requeue on error** - failed items are put back for retry, not silently lost
- **Serialized flushes** - the flusher callback is never invoked in parallel with itself
- **Graceful shutdown** - `drain()` flushes remaining items before stopping
- **Svelte store compatible** - reactive subscriptions for UI binding
- **TypeScript** - fully typed with generics

## Installation

```bash
# Deno
deno add jsr:@marianmeres/batch

# Node.js
npm install @marianmeres/batch
```

## Quick Start

```typescript
import { BatchFlusher } from "@marianmeres/batch";

// Create a batcher that flushes every 5 seconds
const batcher = new BatchFlusher<string>(
  async (items) => {
    await sendToServer(items);
    return true;
  },
  {
    flushIntervalMs: 5000,
    maxBatchSize: 1000,
  }
);

batcher.add("event-1");
batcher.add("event-2");

// Graceful shutdown (flushes remaining items and stops)
await batcher.drain();
```

## Flush Modes

```typescript
// Interval mode: flush every 5 seconds
{ flushIntervalMs: 5000, maxBatchSize: 100 }

// Amount mode: flush when 50 items collected
{ flushIntervalMs: 0, flushThreshold: 50, maxBatchSize: 100 }

// Combined mode: flush every 5s OR when 50 items collected
{ flushIntervalMs: 5000, flushThreshold: 50, maxBatchSize: 100 }
```

## Failure Handling

The flusher callback has three possible outcomes:

| Return / behavior | Result |
|-------------------|--------|
| Returns `true`   | Success — items consumed |
| Returns `false`  | Handled failure — items discarded, boolean propagated to caller, `onFlushError` **not** called |
| Throws           | Unhandled failure — items are **requeued** at the head of the buffer (subject to `maxBatchSize`), `onFlushError` is called, and the error propagates from direct `flush()` / `drain()` calls |

Auto-triggered flushes (timer / threshold) always swallow errors — they log
(warn level by default, error level if `strictFlush: true`) but never produce
unhandled promise rejections.

```typescript
const batcher = new BatchFlusher<Event>(
  async (items) => {
    await send(items); // may throw
    return true;
  },
  {
    flushIntervalMs: 5000,
    maxBatchSize: 1000,
    onFlushError: (items, err) => metrics.incr("flush.failed", items.length),
    onDrop: (items) => metrics.incr("flush.dropped", items.length),
  }
);
```

## Use Cases

- Log aggregation
- Metrics collection
- Event batching
- Database write batching
- API request batching

## State Awareness

```typescript
batcher.size;          // items currently buffered
batcher.isRunning;     // interval scheduler is on
batcher.isFlushing;    // a flush is in progress
batcher.droppedCount;  // items discarded by maxBatchSize cap over lifetime
```

## Reactive Subscriptions (Svelte Store Compatible)

```typescript
// state.size, state.isRunning, state.isFlushing
const unsubscribe = batcher.subscribe((state) => {
  console.log(state);
});
```

State updates are emitted on:

- Item added (`size` changes)
- Buffer reset (`size` changes)
- Flush start/end (`isFlushing` changes, `size` changes)
- Start/stop (`isRunning` changes)

## API

See [API.md](API.md) for full API documentation.

## Changes in 1.2.0

This release fixes several bugs around concurrency, shutdown, and error handling.
Most changes are behavior-preserving for correct usage, but some edge-case
behaviors have changed — see below.

### Bug fixes (behavior differences are bug fixes)

- **`stop()` / `drain()` no longer leak a timer** when called while a scheduled
  flush is in flight. Previously the scheduler could re-arm itself after a stop.
- **`start()` is now idempotent.** Previously, calling `start()` twice created
  parallel timer chains.
- **Items are no longer silently lost on flusher throw.** They are requeued at
  the head of the buffer (subject to `maxBatchSize`).
- **Concurrent `flush()` calls are now serialized.** The flusher callback is
  never invoked in parallel with itself on the same instance. Previously, a
  threshold trigger firing alongside an interval tick could overlap.
- **`strictFlush: true` no longer produces unhandled promise rejections.**
  Errors in auto-triggered flushes are always caught; `strictFlush` now only
  controls log severity (`error` vs `warn`).
- **`configure({ logger })` now takes effect.** Previously the logger was
  cached in the constructor and later updates were silently ignored.

### Additive (non-breaking)

- New config options: `onFlushError(items, err)`, `onDrop(items)`.
- New readonly property: `droppedCount`.
- `BatchFlusherConfig` is now generic in `T` (defaults to `unknown`, so existing
  untyped usage continues to work).

### Potentially breaking (edge cases)

- **`configure()` throws `RangeError` on invalid numeric values** (`maxBatchSize <= 0`,
  negative `flushIntervalMs` / `flushThreshold`, non-finite values). Previously
  these were silently accepted with undefined behavior (e.g. `maxBatchSize: 0`
  effectively disabled the cap).
- **`stop()` is a no-op if the batcher is not running.** Previously it would
  still emit a state-change notification. This affects only subscribers
  counting no-op stops.
- **`strictFlush: true` no longer rethrows from the timer/threshold path.**
  The original behavior (unhandled promise rejection) was a bug; if your code
  relied on process-level rejection handlers to observe these errors, hook
  `onFlushError` instead.
- **Flusher throw now requeues instead of discarding.** If you relied on throw
  = drop (rare), return `false` instead — that path still discards.
- **Removed docs-only `debug` config option.** It was documented in earlier
  versions of `API.md` / `AGENTS.md` but never implemented. Use a custom
  `logger` for verbose output.

## License

MIT
