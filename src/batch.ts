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
 */
export interface BatchFlusherConfig {
	/**
	 * How often (ms) to flush the batch automatically.
	 * Set to `0` or `undefined` to disable interval-based flushing.
	 * @default 1000
	 */
	flushIntervalMs?: number;

	/**
	 * Maximum number of items to keep in the buffer.
	 * Acts as a safety cap - when exceeded, oldest items are discarded.
	 * Does NOT trigger a flush when reached.
	 * @default 100
	 */
	maxBatchSize: number;

	/**
	 * Flush immediately when this many items have accumulated.
	 * Set to `0` or `undefined` to disable threshold-based flushing.
	 * @default undefined
	 */
	flushThreshold?: number;

	/**
	 * If `true`, rethrows any errors from the flush callback.
	 * If `false`, errors are logged as warnings and swallowed.
	 * @default false
	 */
	strictFlush?: boolean;

	/**
	 * Custom logger instance. Falls back to `console` if not provided.
	 * @default console
	 */
	logger?: Logger;
}

/**
 * A generic batch processor that collects items and flushes them based on configured triggers.
 *
 * Supports three flush modes:
 * - **Interval mode**: Flushes at fixed time intervals (`flushIntervalMs`)
 * - **Amount mode**: Flushes when item count reaches threshold (`flushThreshold`)
 * - **Combined mode**: Flushes on whichever trigger fires first
 *
 * @typeParam T - The type of items being batched
 *
 * @example
 * ```ts
 * // Interval mode: flush every 5 seconds
 * const batcher = new BatchFlusher<LogEntry>(
 *   async (items) => {
 *     await sendToServer(items);
 *     return true;
 *   },
 *   { flushIntervalMs: 5000, maxBatchSize: 1000 }
 * );
 *
 * batcher.add({ level: 'info', message: 'Hello' });
 * ```
 *
 * @example
 * ```ts
 * // Amount mode: flush when 10 items collected
 * const batcher = new BatchFlusher<Event>(
 *   async (items) => { await process(items); return true; },
 *   { flushIntervalMs: 0, flushThreshold: 10, maxBatchSize: 100 }
 * );
 * ```
 *
 * @example
 * ```ts
 * // Combined mode: flush every 5s OR when 50 items collected
 * const batcher = new BatchFlusher<Metric>(
 *   async (items) => { await upload(items); return true; },
 *   { flushIntervalMs: 5000, flushThreshold: 50, maxBatchSize: 200 }
 * );
 * ```
 */
export class BatchFlusher<T> {
	#config: BatchFlusherConfig = {
		flushIntervalMs: 1_000,
		maxBatchSize: 100,
		strictFlush: false,
	};
	#items: T[] = [];
	#flushTimer: ReturnType<typeof setTimeout> | undefined;
	#running: boolean = false;
	#flushing: boolean = false;
	#pubsub = createPubSub();
	#logger: Logger;

	/** Returns the current state snapshot for subscribers */
	#getState(): BatchFlusherState {
		return {
			size: this.#items.length,
			isRunning: this.#running,
			isFlushing: this.#flushing,
		};
	}

	/** Notifies all subscribers of state change */
	#notify(): void {
		this.#pubsub.publish("state", this.#getState());
	}

	/**
	 * Creates a new BatchFlusher instance.
	 *
	 * @param flusher - Async callback invoked with batched items when a flush occurs.
	 *                  Should return `true` on success, `false` on failure.
	 * @param config - Optional configuration overrides.
	 * @param autostart - If `true` (default), starts auto-flushing immediately.
	 *                    Set to `false` to manually call `start()` later.
	 */
	constructor(
		protected _flusher: (items: T[]) => Promise<boolean>,
		config?: Partial<BatchFlusherConfig>,
		autostart: boolean = true
	) {
		if (config) this.configure(config);
		this.#logger = withNamespace(
			this.#config.logger ?? createClog(),
			"BatchFlusher"
		);
		autostart && this.start();
	}

	/**
	 * Returns the current number of items in the batch buffer.
	 * @returns The current batch size.
	 */
	get size(): number {
		return this.#items.length;
	}

	/**
	 * Returns whether automatic interval-based flushing is currently active.
	 * @returns `true` if running, `false` otherwise.
	 */
	get isRunning(): boolean {
		return this.#running;
	}

	/**
	 * Returns whether a flush operation is currently in progress.
	 * @returns `true` if flushing, `false` otherwise.
	 */
	get isFlushing(): boolean {
		return this.#flushing;
	}

	/**
	 * Adds an item to the batch buffer.
	 *
	 * If the buffer exceeds `maxBatchSize`, oldest items are discarded.
	 * If `flushThreshold` is set and reached, triggers an immediate flush.
	 *
	 * @param item - The item to add to the batch.
	 */
	add(item: T): void {
		this.#items.push(item);
		this.#logger.debug(`add (size: ${this.#items.length})`);

		// Safety cap: keep only the most recent maxBatchSize items
		if (this.#items.length > this.#config.maxBatchSize) {
			this.#items = this.#items.slice(-this.#config.maxBatchSize);
			this.#logger.debug(
				`maxBatchSize cap applied (size: ${this.#items.length})`
			);
		}

		this.#notify();

		// Threshold trigger: flush immediately if threshold reached
		const threshold = this.#config.flushThreshold;
		if (threshold && this.#items.length >= threshold) {
			this.#logger.debug(
				`flushThreshold reached (${threshold}), flushing...`
			);
			this.#doFlush();
		}
	}

	/**
	 * Clears all items from the batch buffer without flushing.
	 * Useful for testing or resetting state.
	 */
	reset(): void {
		this.#items = [];
		this.#notify();
	}

	/**
	 * Returns a shallow copy of the current batch buffer.
	 * Useful for inspection or testing.
	 *
	 * @returns A copy of the items currently in the buffer.
	 */
	dump(): T[] {
		return [...this.#items];
	}

	/**
	 * Immediately flushes all items in the buffer by invoking the flush callback.
	 *
	 * The buffer is cleared before the callback is invoked to prevent duplicate
	 * processing if new items are added during the async flush operation.
	 *
	 * @returns `true` if flush was successful or buffer was empty, result of
	 *          flusher callback otherwise.
	 */
	async flush(): Promise<boolean> {
		if (!this.#items.length) {
			this.#logger.debug("flush skipped (empty)");
			return true;
		}
		const items = [...this.#items];
		this.#items = [];
		this.#flushing = true;
		this.#notify();
		this.#logger.debug(`flushing ${items.length} items...`);
		try {
			const result = await this._flusher(items);
			this.#logger.debug(`flush complete (result: ${result})`);
			return result;
		} finally {
			this.#flushing = false;
			this.#notify();
		}
	}

	#doFlush = async (): Promise<void> => {
		try {
			await this.flush();
		} catch (e: unknown) {
			if (this.#config.strictFlush) {
				throw e;
			} else {
				const logger = this.#config.logger ?? console;
				logger.warn(`[BatchFlusher] Flush error ignored`, `${e}`);
			}
		}
	};

	#scheduleFlush = (): void => {
		const interval = this.#config.flushIntervalMs;
		if (!interval) return;

		this.#flushTimer = setTimeout(async () => {
			await this.#doFlush();
			clearTimeout(this.#flushTimer);
			this.#scheduleFlush();
		}, interval);
	};

	/**
	 * Starts automatic flushing based on `flushIntervalMs`.
	 *
	 * Called automatically by the constructor unless `autostart` is `false`.
	 * Has no effect if `flushIntervalMs` is `0` or `undefined`.
	 */
	start(): void {
		this.#logger.debug("start");
		this.#running = true;
		this.#notify();
		this.#scheduleFlush();
	}

	/**
	 * Stops automatic interval-based flushing.
	 *
	 * Does not flush remaining items. Call `flush()` before `stop()` if you
	 * need to process remaining items.
	 */
	stop(): void {
		this.#logger.debug("stop");
		this.#running = false;
		clearTimeout(this.#flushTimer);
		this.#notify();
	}

	/**
	 * Gracefully shuts down the batcher by flushing remaining items and stopping.
	 *
	 * Convenience method equivalent to calling `flush()` then `stop()`.
	 *
	 * @returns The result of the final flush operation.
	 */
	async drain(): Promise<boolean> {
		this.#logger.debug("drain");
		const result = await this.flush();
		this.stop();
		return result;
	}

	/**
	 * Updates the configuration with the provided values.
	 * Only defined values are applied; `undefined` values are ignored.
	 *
	 * @param config - Partial configuration to merge with current settings.
	 */
	configure(config: Partial<BatchFlusherConfig>): void {
		Object.entries(config || {}).forEach(([k, v]) => {
			if (v !== undefined) {
				this.#config[k as keyof BatchFlusherConfig] = v as never;
			}
		});
	}

	/**
	 * Subscribes to state changes. Svelte store compatible.
	 *
	 * The callback is invoked immediately with current state, then again
	 * whenever state changes (size, isRunning, isFlushing).
	 *
	 * @param callback - Function called with current state on subscribe and on changes.
	 * @returns Unsubscribe function.
	 *
	 * @example
	 * ```ts
	 * // Svelte component
	 * const batcher = new BatchFlusher(...);
	 * $: state = $batcher; // auto-subscribes via $ syntax
	 * ```
	 *
	 * @example
	 * ```ts
	 * // Manual subscription
	 * const unsubscribe = batcher.subscribe((state) => {
	 *   console.log(`Buffer size: ${state.size}, flushing: ${state.isFlushing}`);
	 * });
	 * // Later: unsubscribe();
	 * ```
	 */
	subscribe(callback: (state: BatchFlusherState) => void): () => void {
		// Immediate callback with current state (Svelte store contract)
		callback(this.#getState());
		// Subscribe to future changes
		return this.#pubsub.subscribe("state", callback);
	}
}
