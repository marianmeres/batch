# @marianmeres/batch

[![JSR](https://jsr.io/badges/@marianmeres/batch)](https://jsr.io/@marianmeres/batch)
[![NPM](https://img.shields.io/npm/v/@marianmeres/batch)](https://www.npmjs.com/package/@marianmeres/batch)

A lightweight, generic batch processor that collects items and flushes them based on
configurable triggers.

## Features

- **Interval mode** - flush at fixed time intervals
- **Amount mode** - flush when item count reaches threshold
- **Combined mode** - flush on whichever trigger fires first
- **Safety cap** - prevents unbounded memory growth
- **Graceful shutdown** - `drain()` flushes remaining items before stopping
- **Debug logging** - optional verbose logging with custom logger support
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
    console.log("Flushing:", items);
    await sendToServer(items);
    return true;
  },
  {
    flushIntervalMs: 5000,
    maxBatchSize: 1000,
  }
);

// Add items - they'll be batched and flushed automatically
batcher.add("event-1");
batcher.add("event-2");

// When done, gracefully shutdown (flushes remaining items and stops)
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

## Use Cases

- Log aggregation
- Metrics collection
- Event batching
- Database write batching
- API request batching

## State Awareness

The batcher exposes two readonly properties for monitoring its internal state:

- **`isRunning`** - Whether automatic interval-based flushing is active. Useful for
  verifying the batcher has started/stopped correctly, or for conditional logic based
  on batcher state.

- **`isFlushing`** - Whether a flush operation is currently in progress. Useful for
  debugging, logging, or UI indicators showing when data is being sent.

```typescript
if (batcher.isRunning) {
  console.log("Batcher is active");
}

if (batcher.isFlushing) {
  console.log("Flush in progress...");
}
```

## Reactive Subscriptions (Svelte Store Compatible)

The batcher implements the Svelte store contract, allowing reactive subscriptions to state
changes:

```typescript
// state.size, state.isRunning, state.isFlushing
const unsubscribe = batcher.subscribe((state) => {
  console.log(state);
});
// Later: unsubscribe();
```

State updates are emitted on:

- Item added (`size` changes)
- Buffer reset (`size` changes)
- Flush start/end (`isFlushing` changes, `size` changes)
- Start/stop (`isRunning` changes)

## API

See [API.md](API.md) for full API documentation.

## License

MIT
