# API Reference

## BatchFlusher\<T\>

A generic batch processor that collects items and flushes them based on configured triggers.

### Flush Modes

| Mode | Configuration | Behavior |
|------|---------------|----------|
| **Interval** | Only `flushIntervalMs` set | Flushes at fixed time intervals |
| **Amount** | Only `flushThreshold` set | Flushes when item count reaches threshold |
| **Combined** | Both set | Flushes on whichever trigger fires first |

### Constructor

```typescript
new BatchFlusher<T>(
  flusher: (items: T[]) => Promise<boolean>,
  config?: Partial<BatchFlusherConfig<T>>,
  autostart?: boolean
)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `flusher` | `(items: T[]) => Promise<boolean>` | required | Async callback invoked with batched items. See [Failure Semantics](#failure-semantics). |
| `config` | `Partial<BatchFlusherConfig<T>>` | `{}` | Configuration overrides |
| `autostart` | `boolean` | `true` | If `true`, starts auto-flushing immediately |

### Properties

#### `size: number` (readonly)

Current number of items in the batch buffer.

#### `isRunning: boolean` (readonly)

Whether automatic interval-based flushing is currently active.

#### `isFlushing: boolean` (readonly)

Whether a flush operation is currently in progress.

#### `droppedCount: number` (readonly)

Total number of items discarded due to `maxBatchSize` over the lifetime of this
instance. Useful for observability.

### Methods

#### `add(item: T): void`

Adds an item to the batch buffer.

- If buffer exceeds `maxBatchSize`, oldest items are discarded (see `onDrop` / `droppedCount`).
- If `flushThreshold` is set and reached, triggers an immediate flush (not awaited).

#### `flush(): Promise<boolean>`

Immediately flushes all items by invoking the flush callback.

- Returns `true` if buffer was empty, or the flusher's boolean result otherwise.
- Buffer is snapshotted and cleared synchronously before the callback runs
  (new items added during the async flush accumulate for the next cycle).
- **Serialized**: if a flush is already in flight, this call waits for it to
  complete and then flushes any remaining items. The flusher callback is
  never invoked in parallel with itself on the same instance.
- On flusher **throw**, items are requeued at the head of the buffer and
  the error propagates. See [Failure Semantics](#failure-semantics).

#### `start(): void`

Starts automatic interval-based flushing.

- Called automatically by constructor unless `autostart` is `false`.
- Has no effect if `flushIntervalMs` is `0` or `undefined`.
- **Idempotent**: calling while already running is a no-op.

#### `stop(): void`

Stops automatic interval-based flushing.

- Does not flush remaining items.
- Idempotent: a no-op if not currently running.
- Safe to call while a scheduled flush is in flight — the scheduler will not
  re-arm itself after stop.

#### `drain(): Promise<boolean>`

Gracefully shuts down the batcher by flushing remaining items and stopping.

- Equivalent to `flush()` then `stop()`.
- Performs a **single** flush — items added **during** the flush remain in the
  buffer when `stop()` is called. If you need those too, loop `flush()`
  yourself before calling `drain()`.

#### `reset(): void`

Clears all items from the buffer without flushing. Invalidates any in-flight
requeue — if the flusher throws after `reset()`, items will **not** be requeued.

#### `dump(): T[]`

Returns a shallow copy of the current buffer. Useful for inspection/testing.

#### `configure(config: Partial<BatchFlusherConfig<T>>): void`

Updates configuration. Only defined values are applied.

- Throws `RangeError` on invalid numeric values (`maxBatchSize <= 0`, negative
  `flushIntervalMs` / `flushThreshold`, non-finite values).
- Updating `logger` takes effect immediately for all subsequent log output.

#### `subscribe(callback: (state: BatchFlusherState) => void): () => void`

Subscribes to state changes. Svelte store compatible.

- Callback is invoked immediately with current state, then again whenever state
  changes (`size`, `isRunning`, `isFlushing`).
- Returns an unsubscribe function.

---

## Failure Semantics

The flusher callback `(items: T[]) => Promise<boolean>` has three possible outcomes:

| Outcome | Effect on items | `onFlushError` | `flush()` caller receives |
|---------|-----------------|----------------|---------------------------|
| Returns `true` | Consumed | Not called | `true` |
| Returns `false` | Discarded | **Not** called | `false` |
| Throws | **Requeued** at head of buffer (subject to `maxBatchSize`) | Called with `(items, error)` | Error rethrown |

Auto-triggered flushes (timer, threshold) always catch errors. `strictFlush`
controls log severity only:
- `strictFlush: false` (default): log at **warn** level.
- `strictFlush: true`: log at **error** level.

Errors from auto-triggered flushes never become unhandled promise rejections.

---

## BatchFlusherState

Reactive state exposed by `subscribe`.

```typescript
interface BatchFlusherState {
  size: number;        // Current number of items in the buffer
  isRunning: boolean;  // Whether automatic interval-based flushing is active
  isFlushing: boolean; // Whether a flush operation is currently in progress
}
```

---

## BatchFlusherConfig\<T\>

```typescript
interface BatchFlusherConfig<T = unknown> {
  flushIntervalMs?: number;
  maxBatchSize: number;
  flushThreshold?: number;
  strictFlush?: boolean;
  logger?: Logger;
  onFlushError?: (items: T[], error: unknown) => void;
  onDrop?: (items: T[]) => void;
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `flushIntervalMs` | `number` | `1000` | Flush interval in ms. `0` disables. Must be finite, `>= 0`. |
| `maxBatchSize` | `number` | `100` | Max items to keep (safety cap). Oldest discarded when exceeded. Must be finite, `> 0`. |
| `flushThreshold` | `number` | `undefined` | Flush immediately when this count is reached. `0` or `undefined` disables. Must be finite, `>= 0`. |
| `strictFlush` | `boolean` | `false` | If `true`, auto-flush errors log at `error` level instead of `warn`. |
| `logger` | `Logger` | `createClog()` | Custom logger. Can be changed at runtime via `configure`. |
| `onFlushError` | `(items, err) => void` | — | Called when the flusher throws. Items are also requeued. |
| `onDrop` | `(items) => void` | — | Called when items are discarded due to `maxBatchSize`. |

---

## Logger

Console-compatible logger interface.

```typescript
interface Logger {
  debug: (...args: unknown[]) => unknown;
  log: (...args: unknown[]) => unknown;
  warn: (...args: unknown[]) => unknown;
  error: (...args: unknown[]) => unknown;
}
```

The `console` object satisfies this interface.
