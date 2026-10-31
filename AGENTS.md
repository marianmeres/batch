# @marianmeres/batch - Agent Reference

Machine-readable documentation for AI agents and code assistants.

## Package Overview

- **Name**: `@marianmeres/batch`
- **Purpose**: Generic batch processor that collects items and flushes them on configurable triggers
- **Stack**: TypeScript (erasable-only), Node LTS (`.node-version`), pnpm, `node:test`, Biome
- **Entry Point**: `./src/mod.ts` (npm: built to `dist/mod.js`)
- **Registries**: npm (built `dist/`, from `package.json`) and JSR (the `.ts` source, from
  `jsr.json`). JSR stays while Deno consumers exist; `package.json` holds the version.
- **Install**: `pnpm install` | **Test**: `pnpm test` | **Check all**: `pnpm run ci` |
  **Build**: `pnpm run build`

## Critical Conventions

1. **Runtime policy** — Node at the keyboard and in production, npm as the registry. No
   `Deno.*`, `Bun.*`, `bun:*`, `jsr:` or `npm:` specifiers in source. Web standards first;
   `node:*` where they don't reach. Nothing is built, tested or documented for Bun.
2. **Erasable TypeScript** — no `enum`, `namespace`, constructor parameter properties;
   `import type` for types; explicit `.ts` import extensions (rewritten to `.js` on emit).
   Node strips types and never checks them: `pnpm run typecheck` is the only type gate.
3. **Formatting** — tabs, 4 wide, 90 columns, double quotes (`biome.json`); manifests
   (`package.json`, `jsr.json`) at 2 spaces. `pnpm run format` before committing;
   `pnpm run lint` is the read-only check CI runs.
4. **Tests** — `node:test` + `node:assert/strict`, importing `../src/*.ts`, never `dist`.
   `pnpm run test:deno` runs the same suite on Deno with `jsr.json` as the config (the JSR
   dependency graph); `publish:jsr` runs it first.
5. **Publishing** — npm gets `dist` + `API.md` + `AGENTS.md` (`files`); JSR gets
   `src/**/*.ts` and the docs (`jsr.json` `publish.include`). `pnpm publish` runs `ci` then
   `build` via `prepublishOnly`. `pnpm run rp` / `rpm` (bump, commit, tag, push, then npm +
   JSR) is a human action. `jsr.json` has no `version`: `publish:jsr` and `jsr:check` pass
   `--set-version` from `package.json`, and `--no-check` (tsc is the type gate; the
   slow-types check still runs).
6. **Dependency `@marianmeres/pubsub`** — an npm dependency in `package.json` and a `jsr:`
   import in `jsr.json`; keep both ranges in step.

## Before Making Changes

- [ ] Add or extend a test in `tests/`, then run `pnpm run ci`
- [ ] Touching the public API or publish shape: also `pnpm run test:deno` and
  `pnpm run jsr:check`
- [ ] Keep this file, `README.md` and `API.md` in step with the code

## Exports

```typescript
export {
	BatchFlusher,
	BatchFlusherConfig,
	BatchFlusherState,
	Logger,
} from "./src/mod.ts";
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
interface BatchFlusherConfig<T = unknown> {
	flushIntervalMs?: number; // default 1000, 0 disables, must be finite >= 0
	maxBatchSize: number; // default 100, safety cap, must be finite > 0
	flushThreshold?: number; // default undefined, set to enable amount mode, must be finite >= 0
	strictFlush?: boolean; // default false — auto-flush error log level (true=error, false=warn)
	logger?: Logger; // default createClog(); runtime-updatable via configure()
	onFlushError?: (items: T[], err: unknown) => void; // called when flusher throws
	onDrop?: (items: T[]) => void; // called on maxBatchSize overflow
}
```

### BatchFlusherState Interface

```typescript
interface BatchFlusherState {
	size: number; // Current buffer size
	isRunning: boolean; // Auto-flushing active
	isFlushing: boolean; // Flush in progress
}
```

### BatchFlusher Class

```typescript
class BatchFlusher<T> {
  constructor(
    flusher: (items: T[]) => Promise<boolean>,
    config?: Partial<BatchFlusherConfig<T>>,
    autostart?: boolean  // default: true
  );

  // Readonly
  get size(): number;
  get isRunning(): boolean;
  get isFlushing(): boolean;
  get droppedCount(): number;

  // Mutation
  add(item: T): void;
  flush(): Promise<boolean>;            // serialized; throws on flusher error
  drain(): Promise<boolean>;            // flush once + stop
  start(): void;                        // idempotent
  stop(): void;                         // idempotent
  reset(): void;                        // clears buffer; invalidates in-flight requeue
  dump(): T[];
  configure(config: Partial<BatchFlusherConfig<T>>): void; // validates; throws RangeError on bad numbers
  subscribe(callback: (state: BatchFlusherState) => void): () => void;
}
```

## Flush Modes

| Mode     | flushIntervalMs | flushThreshold | Behavior                       |
| -------- | --------------- | -------------- | ------------------------------ |
| Interval | > 0             | undefined/0    | Flush at fixed intervals       |
| Amount   | 0/undefined     | > 0            | Flush at item count threshold  |
| Combined | > 0             | > 0            | Flush on whichever fires first |

## Failure Semantics (important)

Flusher `(items) => Promise<boolean>` has three outcomes:

| Outcome         | Items                                            | `onFlushError`             | Direct `flush()` caller sees |
| --------------- | ------------------------------------------------ | -------------------------- | ---------------------------- |
| returns `true`  | consumed                                         | not called                 | resolves to `true`           |
| returns `false` | discarded                                        | **not** called             | resolves to `false`          |
| throws          | **requeued** at head (subject to `maxBatchSize`) | called with `(items, err)` | rejects                      |

Auto-triggered flushes (timer / threshold) always swallow errors after logging.
`strictFlush` only controls log severity (`error` vs `warn`). Errors never
become unhandled promise rejections.

## Key Behaviors

1. **Buffer cap**: `maxBatchSize` discards oldest items when exceeded — surfaced via `droppedCount` and `onDrop`. Does NOT trigger a flush.
2. **Threshold trigger**: `flushThreshold` triggers an immediate flush when the count is reached.
3. **Serialized flushes**: concurrent `flush()` calls queue; the flusher callback is never invoked in parallel with itself.
4. **Synchronous state transition**: `flush()` updates `isFlushing` and clears the buffer synchronously before the first `await`, so subscribers see the change immediately.
5. **Requeue on throw**: items requeued at buffer head (subject to cap). Calling `reset()` during flight suppresses the requeue.
6. **Idempotent `start`/`stop`**: calling twice is safe.
7. **Graceful shutdown**: `drain()` flushes once, then stops. Does NOT loop — items added during the flush stay buffered.
8. **Config validation**: `configure()` throws `RangeError` on invalid numeric values.
9. **Runtime logger swap**: `configure({ logger })` takes effect immediately.

## File Structure

```
src/
  mod.ts               # Entry point; re-exports from batch.ts
  batch.ts             # Main implementation
tests/
  batch.test.ts        # node:test suite (original + regression for bugs B1-B6, D1, D5)
  sleep.ts             # Test utility
dist/                  # `pnpm run build` output; gitignored; what npm publishes
package.json           # npm manifest of record (version, scripts, deps)
jsr.json               # JSR config: exports, publish set, jsr: import of pubsub
tsconfig.json          # type gate over src + tests (noEmit)
tsconfig.build.json    # src → dist (ESM + .d.ts)
biome.json             # format + lint
.github/workflows/ci.yml  # Node only: `pnpm run ci`
```

## Commands

| Task                        | Command                                        |
| --------------------------- | ---------------------------------------------- |
| Run tests (Node)            | `pnpm test` / `pnpm run test:watch`            |
| Run tests (Deno, JSR graph) | `pnpm run test:deno`                           |
| Typecheck                   | `pnpm run typecheck`                           |
| Lint / format               | `pnpm run lint` / `pnpm run format`            |
| Everything CI runs          | `pnpm run ci`                                  |
| Build `dist/`               | `pnpm run build`                               |
| JSR publish dry run         | `pnpm run jsr:check`                           |
| Release + publish npm & JSR | `pnpm run rp` (patch) / `pnpm run rpm` (minor) |

## Usage Patterns

### Basic Interval Mode

```typescript
const batcher = new BatchFlusher<T>(
	async (items) => {
		await process(items);
		return true;
	},
	{ flushIntervalMs: 5000, maxBatchSize: 1000 },
);
batcher.add(item);
await batcher.drain(); // graceful shutdown
```

### Amount Mode (No Timer)

```typescript
const batcher = new BatchFlusher<T>(
	async (items) => {
		await process(items);
		return true;
	},
	{ flushIntervalMs: 0, flushThreshold: 100, maxBatchSize: 500 },
);
```

### With Observability Hooks

```typescript
const batcher = new BatchFlusher<T>(flusher, {
	maxBatchSize: 1000,
	flushIntervalMs: 5000,
	onFlushError: (items, err) => metrics.incr("flush.failed", items.length),
	onDrop: (items) => metrics.incr("flush.dropped", items.length),
	strictFlush: true, // log at error level
});
// Later:
if (batcher.droppedCount > 0) alert("data loss");
```

### With Custom Logger (runtime-updatable)

```typescript
const batcher = new BatchFlusher<T>(flusher, { logger: myLogger, ... });
// Swap at runtime:
batcher.configure({ logger: otherLogger });
```

## Testing Notes

- `node:test` (`test(...)`) + `node:assert/strict`; index access in assertions uses `?.`
  (`log[0]?.join("")`) to satisfy `noUncheckedIndexedAccess` without `!`.
- Tests use `sleep()` helper for timing assertions.
- Use short intervals (20ms) for fast execution.
- Always call `stop()` or `drain()` at end of tests to cleanup timers. A running interval
  re-arms itself, so a forgotten `stop()` keeps the Node test process alive; on Deno
  (`test:deno`) the leak sanitizer fails the test.
- Use `isRunning` to verify start/stop state.
- Use `isFlushing` to check if flush is in progress.
- Use `subscribe()` for reactive state testing (Svelte store compatible).
- Regression tests for known bugs are labeled with tags (B1, B2, B3, B4, B5, B6, D1, D5) in `tests/batch.test.ts`.

## Notes for 1.3.1 (off Deno)

No API change. npm package now built by `tsc`: `exports` use the `default` condition (so
`require()` resolves), `engines.node >=24.12`, `.d.ts` files import each other as `./*.ts`.

## BC Notes for 1.2.0

Behavior changes that could affect existing code:

- **Flusher throw now requeues.** If you relied on throw = drop, return `false` instead.
- **`configure()` throws on invalid numeric values.** `maxBatchSize: 0`, negatives, and non-finite values were previously accepted silently.
- **`strictFlush: true` no longer produces unhandled rejections** — it now only controls log severity. Use `onFlushError` for programmatic access to errors.
- **`start()` / `stop()` are idempotent** — double calls are now no-ops instead of producing leaks or duplicate notifications.
- **`configure({ logger })` now takes effect** (was silently ignored before).
- **`BatchFlusherConfig` is generic** in `T` (default `unknown`), structurally compatible with existing untyped usage.
- **Removed docs-only `debug` option** (never implemented).
