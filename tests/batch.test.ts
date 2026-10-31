import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { BatchFlusher, type Logger } from "../src/batch.ts";
import { sleep } from "./sleep.ts";

test("batch logger works", async () => {
	let log: string[][] = [];

	const flusher = (data: string[]) => {
		log.push(data);
		return Promise.resolve(true);
	};

	const batch = new BatchFlusher(flusher, {
		flushIntervalMs: 20,
		maxBatchSize: 4,
	});

	//
	batch.add("a");
	batch.add("b");
	batch.add("c");

	// log must be empty not (flush interval not reached)
	assert.deepEqual(log.length, 0);
	assert.deepEqual(batch.size, 3);

	// sleep a little, but still not long enough to trigger flushing
	await sleep(10);
	assert.deepEqual(log.length, 0);
	assert.deepEqual(batch.size, 3);

	// now sleep again to reach the flush threshold... log must be full
	await sleep(15);
	assert.deepEqual(log.length, 1);
	assert.deepEqual(log[0]?.join(), ["a", "b", "c"].join());
	assert.deepEqual(batch.size, 0);

	// now test the max size
	log = [];
	batch.reset();

	batch.add("a");
	batch.add("b");
	batch.add("c");
	batch.add("d");
	batch.add("e");

	// "a" must not be in batch anymore (max size is 4)
	assert.deepEqual(batch.dump().join(""), "bcde");

	batch.stop();
});

test("amount mode - flushes at threshold", async () => {
	const log: string[][] = [];

	const flusher = (data: string[]) => {
		log.push(data);
		return Promise.resolve(true);
	};

	// Amount mode only: no interval, just threshold
	const batch = new BatchFlusher(flusher, {
		flushIntervalMs: 0, // disabled
		flushThreshold: 3,
		maxBatchSize: 100,
	});

	batch.add("a");
	batch.add("b");
	assert.deepEqual(log.length, 0); // not yet at threshold
	assert.deepEqual(batch.size, 2);

	batch.add("c"); // triggers flush
	await sleep(5); // allow async flush to complete
	assert.deepEqual(log.length, 1);
	assert.deepEqual(log[0]?.join(""), "abc");
	assert.deepEqual(batch.size, 0);

	// add more
	batch.add("d");
	batch.add("e");
	batch.add("f"); // triggers flush again
	await sleep(5);
	assert.deepEqual(log.length, 2);
	assert.deepEqual(log[1]?.join(""), "def");

	batch.stop();
});

test("combined mode - flushes on whichever comes first", async () => {
	const log: string[][] = [];

	const flusher = (data: string[]) => {
		log.push(data);
		return Promise.resolve(true);
	};

	const batch = new BatchFlusher(flusher, {
		flushIntervalMs: 50,
		flushThreshold: 5,
		maxBatchSize: 100,
	});

	// Add 2 items, wait for interval to flush them
	batch.add("a");
	batch.add("b");
	assert.deepEqual(log.length, 0);

	await sleep(60);
	assert.deepEqual(log.length, 1);
	assert.deepEqual(log[0]?.join(""), "ab");

	// Now add 5 items quickly - should flush at threshold before interval
	batch.add("c");
	batch.add("d");
	batch.add("e");
	batch.add("f");
	batch.add("g"); // triggers threshold flush
	await sleep(5);
	assert.deepEqual(log.length, 2);
	assert.deepEqual(log[1]?.join(""), "cdefg");

	batch.stop();
});

test("custom logger receives lifecycle events", async () => {
	const logs: string[] = [];
	const capture = (...args: unknown[]) => {
		logs.push(args.join(" "));
		return "";
	};
	const mockLogger: Logger = {
		debug: capture,
		log: capture,
		warn: capture,
		error: capture,
	};

	const batch = new BatchFlusher(() => Promise.resolve(true), {
		flushIntervalMs: 0,
		flushThreshold: 2,
		maxBatchSize: 100,
		logger: mockLogger,
	});

	batch.add("a");
	batch.add("b"); // triggers threshold flush
	await sleep(5);

	const joined = logs.join("|");
	assert.match(joined, /start/);
	assert.match(joined, /add/);
	assert.match(joined, /flushThreshold reached/);
	assert.match(joined, /flushing 2 items/);

	batch.stop();
});

test("isRunning reflects start/stop state", () => {
	const batch = new BatchFlusher(
		() => Promise.resolve(true),
		{ flushIntervalMs: 100, maxBatchSize: 10 },
		false, // don't autostart
	);

	assert.deepEqual(batch.isRunning, false);

	batch.start();
	assert.deepEqual(batch.isRunning, true);

	batch.stop();
	assert.deepEqual(batch.isRunning, false);
});

test("drain flushes and stops", async () => {
	const log: string[][] = [];

	const batch = new BatchFlusher<string>(
		(items) => {
			log.push(items);
			return Promise.resolve(true);
		},
		{ flushIntervalMs: 1000, maxBatchSize: 100 },
	);

	assert.deepEqual(batch.isRunning, true);

	batch.add("a");
	batch.add("b");
	batch.add("c");

	assert.deepEqual(log.length, 0);
	assert.deepEqual(batch.size, 3);

	const result = await batch.drain();

	assert.deepEqual(result, true);
	assert.deepEqual(log.length, 1);
	assert.deepEqual(log[0]?.join(""), "abc");
	assert.deepEqual(batch.size, 0);
	assert.deepEqual(batch.isRunning, false);
});

test("isFlushing reflects flush state", async () => {
	let flushingDuringCallback = false;

	const batch = new BatchFlusher<string>(
		async () => {
			// Capture isFlushing state during the async callback
			flushingDuringCallback = batch.isFlushing;
			await sleep(10);
			return true;
		},
		{ flushIntervalMs: 0, maxBatchSize: 10 },
		false,
	);

	assert.deepEqual(batch.isFlushing, false);

	batch.add("a");
	const flushPromise = batch.flush();

	// Should be flushing now
	assert.deepEqual(batch.isFlushing, true);

	await flushPromise;

	// Should be done flushing
	assert.deepEqual(batch.isFlushing, false);
	assert.deepEqual(flushingDuringCallback, true);
});

test("subscribe provides reactive state updates", async () => {
	const states: { size: number; isRunning: boolean; isFlushing: boolean }[] = [];

	const batch = new BatchFlusher<string>(
		async () => {
			await sleep(10);
			return true;
		},
		{ flushIntervalMs: 0, maxBatchSize: 100 },
		false, // don't autostart
	);

	const unsubscribe = batch.subscribe((state) => {
		states.push({ ...state });
	});

	// Initial state should be captured immediately
	assert.deepEqual(states.length, 1);
	assert.deepEqual(states[0], { size: 0, isRunning: false, isFlushing: false });

	// Start should notify
	batch.start();
	assert.deepEqual(states.length, 2);
	assert.deepEqual(states[1]?.isRunning, true);

	// Add items should notify
	batch.add("a");
	batch.add("b");
	assert.deepEqual(states.length, 4);
	assert.deepEqual(states[3]?.size, 2);

	// Flush should notify (start and end)
	const flushPromise = batch.flush();
	assert.deepEqual(states.length, 5);
	assert.deepEqual(states[4]?.isFlushing, true);
	assert.deepEqual(states[4]?.size, 0);

	await flushPromise;
	assert.deepEqual(states.length, 6);
	assert.deepEqual(states[5]?.isFlushing, false);

	// Stop should notify
	batch.stop();
	assert.deepEqual(states.length, 7);
	assert.deepEqual(states[6]?.isRunning, false);

	// Unsubscribe should stop notifications
	unsubscribe();
	batch.add("c");
	assert.deepEqual(states.length, 7); // No new state captured
});

test("stop during in-flight flush does not resurrect scheduler (B1)", async () => {
	let flushCount = 0;
	const batch = new BatchFlusher<string>(
		async () => {
			flushCount++;
			await sleep(30);
			return true;
		},
		{ flushIntervalMs: 10, maxBatchSize: 10 },
	);

	batch.add("a");
	// Wait for the timer to fire and flush to start
	await sleep(20);
	// Now flush is in-flight (still sleeping). Stop while it runs.
	batch.stop();
	// Wait for the in-flight flush to complete + what would have been another interval.
	await sleep(60);

	// Before the fix: scheduler re-armed itself after the in-flight flush,
	// producing additional flush invocations despite stop().
	assert.deepEqual(batch.isRunning, false);
	assert.deepEqual(flushCount, 1);
});

test("double start is idempotent (B2)", async () => {
	let flushCount = 0;
	const batch = new BatchFlusher<string>(
		() => {
			flushCount++;
			return Promise.resolve(true);
		},
		{ flushIntervalMs: 15, maxBatchSize: 10 },
		false,
	);

	batch.start();
	batch.start(); // second start — must not create a second timer chain
	batch.start();

	batch.add("a");
	await sleep(40);
	batch.stop();

	// Without the guard, three overlapping timer chains would multiply flushes.
	assert.deepEqual(flushCount <= 3, true, `expected ≤3 flushes, got ${flushCount}`);
});

test("items are requeued on flusher throw (B3)", async () => {
	let attempts = 0;
	const errors: unknown[] = [];

	const batch = new BatchFlusher<string>(
		async (items) => {
			attempts++;
			if (attempts === 1) throw new Error("transient");
			// Second attempt succeeds
			assert.deepEqual(items.join(""), "ab");
			return true;
		},
		{
			flushIntervalMs: 0,
			maxBatchSize: 10,
			onFlushError: (_items, err) => errors.push(err),
		},
		false,
	);

	batch.add("a");
	batch.add("b");

	// First flush throws.
	let caught: unknown;
	try {
		await batch.flush();
	} catch (e) {
		caught = e;
	}
	assert.deepEqual(String(caught), "Error: transient");
	assert.deepEqual(errors.length, 1);
	// Items must be back in the buffer for retry.
	assert.deepEqual(batch.dump().join(""), "ab");

	// Second flush succeeds with the requeued items.
	const ok = await batch.flush();
	assert.deepEqual(ok, true);
	assert.deepEqual(attempts, 2);
	assert.deepEqual(batch.size, 0);
});

test("requeue preserves ordering when new items arrived during flight (B3)", async () => {
	let attempts = 0;
	const batch = new BatchFlusher<string>(
		async () => {
			attempts++;
			if (attempts === 1) {
				// Simulate new items arriving during the async flush
				await sleep(10);
				throw new Error("fail");
			}
			return true;
		},
		{ flushIntervalMs: 0, maxBatchSize: 10 },
		false,
	);

	batch.add("a");
	batch.add("b");
	const p = batch.flush().catch(() => {});
	// While the flusher is sleeping, add more items
	await sleep(2);
	batch.add("c");
	await p;

	// Requeued [a,b] should be prepended to [c] — order preserved.
	assert.deepEqual(batch.dump().join(""), "abc");
});

test("works standalone with no logger injected (quiet default)", async () => {
	// Stub console.warn / console.error to verify the default logger stays
	// silent for the happy path (no warn/error level events expected here).
	const origWarn = console.warn;
	const origError = console.error;
	const stdoutWarn: unknown[][] = [];
	const stdoutError: unknown[][] = [];
	console.warn = (...args) => stdoutWarn.push(args);
	console.error = (...args) => stdoutError.push(args);

	try {
		const flushed: string[][] = [];
		const batch = new BatchFlusher<string>(
			(items) => {
				flushed.push(items);
				return Promise.resolve(true);
			},
			{ flushIntervalMs: 20, maxBatchSize: 10 },
			// no logger — must work with built-in default
		);

		batch.add("a");
		batch.add("b");
		await sleep(40);

		assert.deepEqual(flushed.length, 1);
		assert.deepEqual(flushed[0]?.join(""), "ab");

		await batch.drain();

		// Default logger should not have emitted anything on the happy path.
		assert.deepEqual(stdoutWarn.length, 0);
		assert.deepEqual(stdoutError.length, 0);
	} finally {
		console.warn = origWarn;
		console.error = origError;
	}
});

test("concurrent flush calls are serialized (B4)", async () => {
	const invocations: string[][] = [];
	let concurrent = 0;
	let maxConcurrent = 0;

	const batch = new BatchFlusher<string>(
		async (items) => {
			concurrent++;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			invocations.push([...items]);
			await sleep(10);
			concurrent--;
			return true;
		},
		{ flushIntervalMs: 0, maxBatchSize: 100 },
		false,
	);

	batch.add("a");
	const p1 = batch.flush();
	batch.add("b");
	const p2 = batch.flush();
	batch.add("c");
	const p3 = batch.flush();

	await Promise.all([p1, p2, p3]);

	// Flusher must never run in parallel with itself.
	assert.deepEqual(maxConcurrent, 1);
	// All items must have been processed.
	assert.deepEqual(invocations.flat().sort().join(""), "abc");
});

test("threshold flush during in-flight flush processes new items (B4)", async () => {
	const batches: string[][] = [];
	const batch = new BatchFlusher<string>(
		async (items) => {
			batches.push([...items]);
			await sleep(15);
			return true;
		},
		{ flushIntervalMs: 0, flushThreshold: 2, maxBatchSize: 100 },
		false,
	);

	batch.add("a");
	batch.add("b"); // triggers first flush (in-flight for 15ms)
	// While first flush is running, add more items to trigger a second threshold.
	await sleep(2);
	batch.add("c");
	batch.add("d"); // triggers second flush (queued behind first)
	await sleep(50);

	assert.deepEqual(batches.length, 2);
	assert.deepEqual(batches[0]?.join(""), "ab");
	assert.deepEqual(batches[1]?.join(""), "cd");
});

test("strictFlush in timer path does not produce unhandled rejection (B5)", async () => {
	let unhandled: unknown;
	const handler = (reason: unknown) => {
		unhandled = reason;
	};
	// While a listener is attached the process does not crash on an unhandled
	// rejection, so the bug, if it re-appears, shows up in `unhandled` instead.
	process.on("unhandledRejection", handler);

	const batch = new BatchFlusher<string>(() => Promise.reject(new Error("boom")), {
		flushIntervalMs: 10,
		maxBatchSize: 10,
		strictFlush: true,
	});

	batch.add("a");
	await sleep(40);
	batch.stop();
	await sleep(20);

	process.off("unhandledRejection", handler);
	assert.deepEqual(unhandled, undefined);
});

test("configure({ logger }) updates active logger (B6)", async () => {
	const logs1: string[] = [];
	const logs2: string[] = [];
	const mk = (sink: string[]): Logger => ({
		debug: (...a) => sink.push(`d:${a.join(" ")}`),
		log: (...a) => sink.push(`l:${a.join(" ")}`),
		warn: (...a) => sink.push(`w:${a.join(" ")}`),
		error: (...a) => sink.push(`e:${a.join(" ")}`),
	});

	const batch = new BatchFlusher<string>(
		() => Promise.resolve(true),
		{ flushIntervalMs: 0, maxBatchSize: 10, logger: mk(logs1) },
		false,
	);
	batch.add("a");
	const before = logs1.length;
	assert.deepEqual(before > 0, true);

	// Swap logger
	batch.configure({ logger: mk(logs2) });
	batch.add("b");

	// logs1 should not have grown
	assert.deepEqual(logs1.length, before);
	// logs2 should have captured the new add
	assert.deepEqual(logs2.length > 0, true);
});

test("droppedCount and onDrop report lossy overflow (D1)", () => {
	const dropped: string[][] = [];
	const batch = new BatchFlusher<string>(
		() => Promise.resolve(true),
		{
			flushIntervalMs: 0,
			maxBatchSize: 3,
			onDrop: (items) => dropped.push(items),
		},
		false,
	);

	for (const c of "abcde") batch.add(c);

	assert.deepEqual(batch.dump().join(""), "cde");
	assert.deepEqual(batch.droppedCount, 2);
	assert.deepEqual(dropped.length, 2); // one drop per overflow
	assert.deepEqual(dropped[0]?.join(""), "a");
	assert.deepEqual(dropped[1]?.join(""), "b");
});

test("configure validates numeric inputs (D5)", () => {
	const batch = new BatchFlusher<string>(
		() => Promise.resolve(true),
		{ flushIntervalMs: 0, maxBatchSize: 10 },
		false,
	);

	let threw = 0;
	try {
		batch.configure({ maxBatchSize: 0 });
	} catch {
		threw++;
	}
	try {
		batch.configure({ maxBatchSize: -1 });
	} catch {
		threw++;
	}
	try {
		batch.configure({ flushIntervalMs: -5 });
	} catch {
		threw++;
	}
	try {
		batch.configure({ flushThreshold: -2 });
	} catch {
		threw++;
	}
	try {
		batch.configure({ maxBatchSize: Infinity });
	} catch {
		threw++;
	}
	assert.deepEqual(threw, 5);

	// Valid values must not throw
	batch.configure({ flushIntervalMs: 0, flushThreshold: 0, maxBatchSize: 1 });
});

test("reset during in-flight flush suppresses requeue-on-error", async () => {
	const batch = new BatchFlusher<string>(
		async () => {
			await sleep(15);
			throw new Error("fail");
		},
		{ flushIntervalMs: 0, maxBatchSize: 10 },
		false,
	);

	batch.add("a");
	batch.add("b");
	const p = batch.flush().catch(() => {});
	await sleep(2);
	// User explicitly cleared the buffer during the flush
	batch.reset();
	await p;

	// Without the reset-generation check, requeue would put [a,b] back.
	assert.deepEqual(batch.size, 0);
});
