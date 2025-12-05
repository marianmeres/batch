# API Reference

## BatchFlusher\<T\>

A generic batch processor that collects items and flushes them based on configured triggers.

### Flush Modes

The flusher operates in one of three modes depending on configuration:

| Mode | Configuration | Behavior |
|------|---------------|----------|
| **Interval** | Only `flushIntervalMs` set | Flushes at fixed time intervals |
| **Amount** | Only `flushThreshold` set | Flushes when item count reaches threshold |
| **Combined** | Both set | Flushes on whichever trigger fires first |

### Constructor

```typescript
new BatchFlusher<T>(
  flusher: (items: T[]) => Promise<boolean>,
  config?: Partial<BatchFlusherConfig>,
  autostart?: boolean
)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `flusher` | `(items: T[]) => Promise<boolean>` | required | Async callback invoked with batched items. Return `true` on success. |
| `config` | `Partial<BatchFlusherConfig>` | `{}` | Configuration overrides |
| `autostart` | `boolean` | `true` | If `true`, starts auto-flushing immediately |

### Properties

#### `size: number` (readonly)

Returns the current number of items in the batch buffer.

#### `isRunning: boolean` (readonly)

Returns whether automatic interval-based flushing is currently active.

#### `isFlushing: boolean` (readonly)

Returns whether a flush operation is currently in progress.

### Methods

#### `add(item: T): void`

Adds an item to the batch buffer.

- If buffer exceeds `maxBatchSize`, oldest items are discarded
- If `flushThreshold` is set and reached, triggers an immediate flush

#### `flush(): Promise<boolean>`

Immediately flushes all items by invoking the flush callback.

- Returns `true` if buffer was empty or flush succeeded
- Buffer is cleared before callback is invoked (prevents duplicate processing)

#### `start(): void`

Starts automatic interval-based flushing.

- Called automatically by constructor unless `autostart` is `false`
- Has no effect if `flushIntervalMs` is `0` or `undefined`

#### `stop(): void`

Stops automatic interval-based flushing.

- Does not flush remaining items
- Call `flush()` before `stop()` to process remaining items

#### `drain(): Promise<boolean>`

Gracefully shuts down the batcher by flushing remaining items and stopping.

- Convenience method equivalent to calling `flush()` then `stop()`
- Returns the result of the final flush operation

#### `reset(): void`

Clears all items from the buffer without flushing. Useful for testing.

#### `dump(): T[]`

Returns a shallow copy of the current buffer. Useful for inspection/testing.

#### `configure(config: Partial<BatchFlusherConfig>): void`

Updates configuration. Only defined values are applied.

#### `subscribe(callback: (state: BatchFlusherState) => void): () => void`

Subscribes to state changes. Svelte store compatible.

- Callback is invoked immediately with current state
- Callback is invoked again whenever state changes (size, isRunning, isFlushing)
- Returns an unsubscribe function

```typescript
// Svelte component usage
const batcher = new BatchFlusher(...);
$: state = $batcher; // auto-subscribes via $ syntax

// Manual subscription
const unsubscribe = batcher.subscribe((state) => {
  console.log(`Buffer size: ${state.size}, flushing: ${state.isFlushing}`);
});
// Later: unsubscribe();
```

---

## BatchFlusherState

Reactive state exposed by BatchFlusher's `subscribe` method.

```typescript
interface BatchFlusherState {
  size: number;        // Current number of items in the buffer
  isRunning: boolean;  // Whether automatic interval-based flushing is active
  isFlushing: boolean; // Whether a flush operation is currently in progress
}
```

---

## BatchFlusherConfig

Configuration options for BatchFlusher.

```typescript
interface BatchFlusherConfig {
  flushIntervalMs?: number;
  maxBatchSize: number;
  flushThreshold?: number;
  strictFlush?: boolean;
  debug?: boolean;
  logger?: Logger;
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `flushIntervalMs` | `number` | `1000` | Flush interval in ms. Set to `0` to disable. |
| `maxBatchSize` | `number` | `100` | Max items to keep (safety cap). Oldest discarded when exceeded. |
| `flushThreshold` | `number` | `undefined` | Flush immediately when this count is reached. |
| `strictFlush` | `boolean` | `false` | If `true`, rethrows flush errors. Otherwise logs warning. |
| `debug` | `boolean` | `false` | Enable verbose debug logging. |
| `logger` | `Logger` | `console` | Custom logger instance. |

---

## Logger

Console-compatible logger interface for custom logging integration.

```typescript
interface Logger {
  debug: (...args: unknown[]) => unknown;
  log: (...args: unknown[]) => unknown;
  warn: (...args: unknown[]) => unknown;
  error: (...args: unknown[]) => unknown;
}
```

The `console` object satisfies this interface and is used as the default.
