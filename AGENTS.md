# @marianmeres/batch - Agent Reference

Machine-readable documentation for AI agents and code assistants.

## Package Overview

- **Name**: `@marianmeres/batch`
- **Purpose**: Generic batch processor that collects items and flushes them on configurable triggers
- **Runtime**: Deno (also published to npm)
- **Entry Point**: `./src/mod.ts`

## Exports

```typescript
export { BatchFlusher, BatchFlusherConfig, BatchFlusherState, Logger } from "./src/mod.ts";
```

## Core Types

### Logger Interface

```typescript
interface Logger {
  debug: (...args: unknown[]) => unknown;
  log: (...args: unknown[]) => unknown;
  warn: (...args: unknown[]) => unknown;
  error: (...args: unknown[]) => unknown;
}
```

### BatchFlusherConfig Interface

```typescript
interface BatchFlusherConfig {
  flushIntervalMs?: number;   // default: 1000, set 0 to disable
  maxBatchSize: number;       // default: 100, safety cap
  flushThreshold?: number;    // default: undefined, set to enable amount mode
  strictFlush?: boolean;      // default: false
  debug?: boolean;            // default: false
  logger?: Logger;            // default: console
}
```

### BatchFlusherState Interface

```typescript
interface BatchFlusherState {
  size: number;        // Current buffer size
  isRunning: boolean;  // Auto-flushing active
  isFlushing: boolean; // Flush in progress
}
```

### BatchFlusher Class

```typescript
class BatchFlusher<T> {
  constructor(
    flusher: (items: T[]) => Promise<boolean>,
    config?: Partial<BatchFlusherConfig>,
    autostart?: boolean  // default: true
  );

  get size(): number;
  get isRunning(): boolean;
  get isFlushing(): boolean;
  add(item: T): void;
  flush(): Promise<boolean>;
  drain(): Promise<boolean>;  // flush + stop
  start(): void;
  stop(): void;
  reset(): void;
  dump(): T[];
  configure(config: Partial<BatchFlusherConfig>): void;
  subscribe(callback: (state: BatchFlusherState) => void): () => void;
}
```

## Flush Modes

Mode is determined implicitly by configuration:

| Mode | flushIntervalMs | flushThreshold | Behavior |
|------|-----------------|----------------|----------|
| Interval | > 0 | undefined/0 | Flush at fixed intervals |
| Amount | 0/undefined | > 0 | Flush at item count threshold |
| Combined | > 0 | > 0 | Flush on whichever fires first |

## Key Behaviors

1. **Buffer Safety**: `maxBatchSize` caps buffer size by discarding oldest items (does NOT trigger flush)
2. **Threshold Trigger**: `flushThreshold` triggers immediate flush when count reached
3. **Async Flush**: `flush()` clears buffer before calling callback (prevents duplicates)
4. **Error Handling**: Errors swallowed with warning unless `strictFlush: true`
5. **Autostart**: Constructor starts interval scheduling by default
6. **Graceful Shutdown**: `drain()` flushes remaining items then stops

## File Structure

```
src/
  mod.ts          # Re-exports from batch.ts
  batch.ts        # Main implementation
tests/
  batch.test.ts   # Unit tests
  sleep.ts        # Test utility
scripts/
  build-npm.ts    # npm build script
```

## Tasks

```bash
deno task test          # Run tests
deno task test:watch    # Run tests in watch mode
deno task npm:build     # Build npm package
deno task npm:publish   # Build and publish to npm
deno task publish       # Publish to JSR and npm
```

## Usage Patterns

### Basic Interval Mode

```typescript
const batcher = new BatchFlusher<T>(
  async (items) => { await process(items); return true; },
  { flushIntervalMs: 5000, maxBatchSize: 1000 }
);
batcher.add(item);
// ... later
await batcher.drain(); // graceful shutdown
```

### Amount Mode (No Timer)

```typescript
const batcher = new BatchFlusher<T>(
  async (items) => { await process(items); return true; },
  { flushIntervalMs: 0, flushThreshold: 100, maxBatchSize: 500 }
);
```

### With Custom Logger

```typescript
const batcher = new BatchFlusher<T>(
  flusher,
  {
    debug: true,
    logger: myCustomLogger,
    // ... other options
  }
);
```

## Testing Notes

- Tests use `sleep()` helper for timing assertions
- Test with short intervals (20ms) for fast execution
- Always call `stop()` or `drain()` at end of tests to cleanup timers
- Use `isRunning` to verify start/stop state
- Use `isFlushing` to check if flush is in progress
- Use `subscribe()` for reactive state testing (Svelte store compatible)
