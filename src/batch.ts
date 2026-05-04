import { createPubSub } from "@marianmeres/pubsub";
import { type Logger, withNamespace, createClog } from "@marianmeres/clog";

/**
 * Reactive state exposed by BatchFlusher's subscribe method.
 * Designed for UI binding scenarios (Svelte store compatible).
 */
export interface BatchFlusherState {
	/** Current number of items in the buffer */
	size: number;
	/** Whether automatic interval-based flushing is active */
	isRunning: boolean;
	/** Whether a flush operation is currently in progress */
	isFlushing: boolean;
}

/**
 * Configuration options for BatchFlusher.
 *
 * Supports three flush modes based on which options are set:
 * - **Interval mode**: Only `flushIntervalMs` set - flushes at fixed time intervals
 * - **Amount mode**: Only `flushThreshold` set - flushes when item count reaches threshold
 * - **Combined mode**: Both set - flushes on whichever triggers first
 *
 * @typeParam T - Item type (only referenced by the optional `onFlushError` and
 *                `onDrop` callbacks; defaults to `unknown`).
 */
export interface BatchFlusherConfig<T = unknown> {
	/**
	 * How often (ms) to flush the batch automatically.
	 * Set to `0` or `undefined` to disable interval-based flushing.
	 * Must be a finite, non-negative number.
	 * @default 1000
	 */
	flushIntervalMs?: number;

	/**
	 * Maximum number of items to keep in the buffer.
	 * Acts as a safety cap — when exceeded, oldest items are discarded
	 * (see `onDrop` and `droppedCount`). Does NOT trigger a flush.
	 * Must be a finite number greater than 0.
	 * @default 100
	 */
	maxBatchSize: number;

	/**
	 * Flush immediately when this many items have accumulated.
	 * Set to `0` or `undefined` to disable threshold-based flushing.
	 * Must be a finite, non-negative number.
	 * @default undefined
	 */
	flushThreshold?: number;

	/**
	 * Controls log level for errors from **auto-triggered** flushes
	 * (timer / threshold). Errors are always caught — they never become
	 * unhandled promise rejections — this flag only affects log severity:
	 * - `true`: errors logged at **error** level
	 * - `false`: errors logged at **warn** level
	 *
	 * Direct calls to `flush()` always reject on failure regardless of this setting.
	 * @default false
	 */
	strictFlush?: boolean;

	/**
	 * Custom logger instance. Falls back to `createClog()` if not provided.
	 * Can be updated at runtime via `configure({ logger })`.
	 */
	logger?: Logger;

	/**
	 * Invoked when the flusher callback **throws**. Receives the items that
	 * failed (they are also requeued at the head of the buffer, subject to
	 * `maxBatchSize`) and the error.
	 *
	 * Note: NOT called when the flusher returns `false` — a `false` return is
	 * considered a handled failure by the caller (items are discarded).
	 */
	onFlushError?: (items: T[], error: unknown) => void;

	/**
	 * Invoked when items are discarded due to the `maxBatchSize` cap.
	 * Receives the dropped items in insertion order (oldest first).
	 */
	onDrop?: (items: T[]) => void;
}

/**
 * A generic batch processor that collects items and flushes them based on configured triggers.
 *
 * Supports three flush modes:
 * - **Interval mode**: Flushes at fixed time intervals (`flushIntervalMs`)
 * - **Amount mode**: Flushes when item count reaches threshold (`flushThreshold`)
 * - **Combined mode**: Flushes on whichever trigger fires first
 *
 * ### Failure handling
 *
 * - **Flusher throws**: items are requeued at the head of the buffer (subject to
 *   `maxBatchSize`), `onFlushError` is called, and the error propagates from
 *   direct `flush()` / `drain()` callers. Auto-triggered flushes log and swallow.
 * - **Flusher returns `false`**: treated as a handled failure — items are
 *   discarded, the boolean is returned to the caller, `onFlushError` is NOT called.
 * - **Flusher returns `true`**: success, items consumed.
 *
 * ### Concurrency
 *
 * Concurrent `flush()` calls are serialized — if a flush is in-flight, the next
 * call waits for it, then flushes any remaining items. The flusher callback is
 * therefore never invoked in parallel with itself on the same instance.
 *
 * @typeParam T - The type of items being batched.
 *
 * @example
 * ```ts
 * // Interval mode: flush every 5 seconds
 * const batcher = new BatchFlusher<LogEntry>(
 *   async (items) => { await sendToServer(items); return true; },
 *   { flushIntervalMs: 5000, maxBatchSize: 1000 }
 * );
 * batcher.add({ level: 'info', message: 'Hello' });
 * ```
 */
export class BatchFlusher<T> {
	#config: BatchFlusherConfig<T> = {
		flushIntervalMs: 1_000,
		maxBatchSize: 100,
		strictFlush: false,
	};
	#items: T[] = [];
	#flushTimer: ReturnType<typeof setTimeout> | undefined;
	#running: boolean = false;
	#flushing: boolean = false;
	#inFlight: Promise<boolean> | undefined;
	#droppedCount: number = 0;
	/**
	 * Generation counter incremented on every `reset()`. Used to suppress
	 * requeue-on-failure if the caller explicitly cleared the buffer while a
	 * flush was in flight.
	 */
	#generation: number = 0;
	#pubsub = createPubSub();
	#logger: Logger;

	#getState(): BatchFlusherState {
		return {
			size: this.#items.length,
			isRunning: this.#running,
			isFlushing: this.#flushing,
		};
	}

	#notify(): void {
		this.#pubsub.publish("state", this.#getState());
	}

	/**
	 * Creates a new BatchFlusher instance.
	 *
	 * @param flusher - Async callback invoked with batched items on flush.
	 *                  Return `true` on success, `false` on handled failure
	 *                  (items discarded), or throw to trigger requeue.
	 * @param config - Optional configuration overrides.
	 * @param autostart - If `true` (default), starts auto-flushing immediately.
	 */
	constructor(
		protected _flusher: (items: T[]) => Promise<boolean>,
		config?: Partial<BatchFlusherConfig<T>>,
		autostart: boolean = true,
	) {
		this.#logger = createClog("BatchFlusher");
		if (config) this.configure(config);
		if (autostart) this.start();
	}

	/** Current number of items in the batch buffer. */
	get size(): number {
		return this.#items.length;
	}

	/** Whether automatic interval-based flushing is currently active. */
	get isRunning(): boolean {
		return this.#running;
	}

	/** Whether a flush operation is currently in progress. */
	get isFlushing(): boolean {
		return this.#flushing;
	}

	/**
	 * Total number of items discarded due to `maxBatchSize` over the lifetime
	 * of this instance. Useful for observability / diagnostics.
	 */
	get droppedCount(): number {
		return this.#droppedCount;
	}

	/**
	 * Adds an item to the batch buffer.
	 *
	 * If the buffer exceeds `maxBatchSize`, oldest items are discarded
	 * (see `onDrop`, `droppedCount`). If `flushThreshold` is set and reached,
	 * triggers an immediate flush (not awaited).
	 */
	add(item: T): void {
		this.#items.push(item);
		this.#logger.debug(`add (size: ${this.#items.length})`);
		this.#applyCap();
		this.#notify();

		const threshold = this.#config.flushThreshold;
		if (threshold && this.#items.length >= threshold) {
			this.#logger.debug(
				`flushThreshold reached (${threshold}), flushing...`,
			);
			// Fire-and-forget; errors are handled inside #doFlush.
			this.#doFlush();
		}
	}

	/** Clears the buffer without flushing. Invalidates any in-flight requeue. */
	reset(): void {
		this.#generation++;
		this.#items = [];
		this.#notify();
	}

	/** Returns a shallow copy of the current buffer. */
	dump(): T[] {
		return [...this.#items];
	}

	/**
	 * Immediately flushes all items in the buffer by invoking the flush callback.
	 *
	 * The buffer is snapshotted and cleared synchronously before the callback is
	 * invoked, so new items added during the async flush accumulate for the next
	 * cycle (no duplicate processing).
	 *
	 * If a flush is already in flight, this call waits for it and then flushes
	 * any items remaining — flushes are serialized.
	 *
	 * On flusher throw, items are requeued at the head of the buffer and the
	 * error propagates.
	 *
	 * @returns `true` if the buffer was empty or the flusher succeeded;
	 *          otherwise the flusher's boolean result.
	 */
	async flush(): Promise<boolean> {
		// Serialize: if a flush is in flight, wait for it then retry.
		if (this.#inFlight) {
			try {
				await this.#inFlight;
			} catch {
				/* already handled by the in-flight flush's own try/finally */
			}
			return this.flush();
		}

		if (!this.#items.length) {
			this.#logger.debug("flush skipped (empty)");
			return true;
		}

		// Snapshot + clear synchronously so subscribers see the state transition
		// immediately when flush() is called (Svelte store contract).
		const items = [...this.#items];
		const gen = this.#generation;
		this.#items = [];
		this.#flushing = true;
		this.#notify();
		this.#logger.debug(`flushing ${items.length} items...`);

		const promise = this.#invokeFlusher(items, gen);
		this.#inFlight = promise;
		try {
			return await promise;
		} finally {
			this.#inFlight = undefined;
			this.#flushing = false;
			this.#notify();
		}
	}

	async #invokeFlusher(items: T[], gen: number): Promise<boolean> {
		try {
			const result = await this._flusher(items);
			this.#logger.debug(`flush complete (result: ${result})`);
			return result;
		} catch (e) {
			this.#logger.debug(`flush threw, requeuing ${items.length} items`);
			// Only requeue if the buffer wasn't explicitly cleared mid-flight.
			if (gen === this.#generation) {
				this.#requeue(items);
			} else {
				this.#logger.debug("skipping requeue (buffer was reset)");
			}
			try {
				this.#config.onFlushError?.(items, e);
			} catch (cbErr) {
				this.#logger.warn("onFlushError callback threw", cbErr);
			}
			throw e;
		}
	}

	/** Prepend failed items back into the buffer, then apply the cap. */
	#requeue(items: T[]): void {
		this.#items = items.concat(this.#items);
		this.#applyCap();
	}

	/** Drop oldest items if buffer exceeds maxBatchSize. */
	#applyCap(): void {
		const max = this.#config.maxBatchSize;
		if (this.#items.length > max) {
			const drop = this.#items.length - max;
			const dropped = this.#items.slice(0, drop);
			this.#droppedCount += drop;
			this.#items = this.#items.slice(drop);
			this.#logger.debug(
				`maxBatchSize cap applied (dropped: ${drop}, total: ${this.#droppedCount})`,
			);
			try {
				this.#config.onDrop?.(dropped);
			} catch (e) {
				this.#logger.warn("onDrop callback threw", e);
			}
		}
	}

	/** Internal flush entry point for auto-triggered flushes (timer / threshold). */
	#doFlush = async (): Promise<void> => {
		try {
			await this.flush();
		} catch (e: unknown) {
			if (this.#config.strictFlush) {
				this.#logger.error("flush error (strict mode)", `${e}`);
			} else {
				this.#logger.warn("flush error ignored", `${e}`);
			}
		}
	};

	#scheduleFlush = (): void => {
		const interval = this.#config.flushIntervalMs;
		if (!interval || !this.#running) return;

		this.#flushTimer = setTimeout(async () => {
			// Errors are fully contained inside #doFlush — this never throws.
			await this.#doFlush();
			// Respect concurrent stop(): only reschedule if still running.
			if (this.#running) this.#scheduleFlush();
		}, interval);
	};

	/**
	 * Starts automatic flushing based on `flushIntervalMs`. Idempotent —
	 * calling while already running is a no-op.
	 */
	start(): void {
		if (this.#running) {
			this.#logger.debug("start: already running");
			return;
		}
		this.#logger.log("start");
		this.#running = true;
		this.#notify();
		this.#scheduleFlush();
	}

	/**
	 * Stops automatic interval-based flushing. Does not flush remaining items —
	 * call `flush()` or `drain()` first if needed. Idempotent.
	 */
	stop(): void {
		if (!this.#running) {
			this.#logger.debug("stop: not running");
			return;
		}
		this.#logger.log("stop");
		this.#running = false;
		if (this.#flushTimer !== undefined) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
		}
		this.#notify();
	}

	/**
	 * Gracefully shuts down the batcher by flushing remaining items and stopping.
	 *
	 * Note: this performs a single flush; items added **during** the flush remain
	 * in the buffer when `stop()` is called. If you need those flushed, call
	 * `flush()` in a loop before `drain()`.
	 */
	async drain(): Promise<boolean> {
		this.#logger.log("drain");
		const result = await this.flush();
		this.stop();
		return result;
	}

	/**
	 * Updates configuration with the provided values. Only defined values are
	 * applied; `undefined` keys are ignored. Throws `RangeError` on invalid
	 * numeric values.
	 *
	 * Updating `logger` takes effect immediately for all subsequent log output.
	 */
	configure(config: Partial<BatchFlusherConfig<T>>): void {
		if (!config) return;

		if (
			config.maxBatchSize !== undefined &&
			(!Number.isFinite(config.maxBatchSize) || config.maxBatchSize <= 0)
		) {
			throw new RangeError(
				`BatchFlusher: maxBatchSize must be a finite number > 0, got ${config.maxBatchSize}`,
			);
		}
		if (
			config.flushIntervalMs !== undefined &&
			(!Number.isFinite(config.flushIntervalMs) ||
				config.flushIntervalMs < 0)
		) {
			throw new RangeError(
				`BatchFlusher: flushIntervalMs must be a finite number >= 0, got ${config.flushIntervalMs}`,
			);
		}
		if (
			config.flushThreshold !== undefined &&
			(!Number.isFinite(config.flushThreshold) ||
				config.flushThreshold < 0)
		) {
			throw new RangeError(
				`BatchFlusher: flushThreshold must be a finite number >= 0, got ${config.flushThreshold}`,
			);
		}

		for (const [k, v] of Object.entries(config)) {
			if (v !== undefined) {
				(this.#config as unknown as Record<string, unknown>)[k] = v;
			}
		}

		if (config.logger !== undefined) {
			this.#logger = withNamespace(config.logger, "BatchFlusher");
		}
	}

	/**
	 * Subscribes to state changes. Svelte store compatible.
	 *
	 * The callback is invoked immediately with current state, then again
	 * whenever state changes (size, isRunning, isFlushing).
	 */
	subscribe(callback: (state: BatchFlusherState) => void): () => void {
		callback(this.#getState());
		return this.#pubsub.subscribe("state", callback);
	}
}
