import { BatchFlusher, type Logger } from "../src/batch.ts";
import { sleep } from "./sleep.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";

Deno.test("batch logger works", async () => {
	let log: any[] = [];

	const flusher = (data: any) => {
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
	assertEquals(log.length, 0);
	assertEquals(batch.size, 3);

	// sleep a little, but still not long enough to trigger flushing
	await sleep(10);
	assertEquals(log.length, 0);
	assertEquals(batch.size, 3);

	// now sleep again to reach the flush threshold... log must be full
	await sleep(15);
	assertEquals(log.length, 1);
	assertEquals(log[0].join(), ["a", "b", "c"].join());
	assertEquals(batch.size, 0);

	// now test the max size
	log = [];
	batch.reset();

	batch.add("a");
	batch.add("b");
	batch.add("c");
	batch.add("d");
	batch.add("e");

	// "a" must not be in batch anymore (max size is 4)
	assertEquals(batch.dump().join(""), "bcde");

	batch.stop();
});

Deno.test("amount mode - flushes at threshold", async () => {
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
	assertEquals(log.length, 0); // not yet at threshold
	assertEquals(batch.size, 2);

	batch.add("c"); // triggers flush
	await sleep(5); // allow async flush to complete
	assertEquals(log.length, 1);
	assertEquals(log[0].join(""), "abc");
	assertEquals(batch.size, 0);

	// add more
	batch.add("d");
	batch.add("e");
	batch.add("f"); // triggers flush again
	await sleep(5);
	assertEquals(log.length, 2);
	assertEquals(log[1].join(""), "def");

	batch.stop();
});

Deno.test("combined mode - flushes on whichever comes first", async () => {
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
	assertEquals(log.length, 0);

	await sleep(60);
	assertEquals(log.length, 1);
	assertEquals(log[0].join(""), "ab");

	// Now add 5 items quickly - should flush at threshold before interval
	batch.add("c");
	batch.add("d");
	batch.add("e");
	batch.add("f");
	batch.add("g"); // triggers threshold flush
	await sleep(5);
	assertEquals(log.length, 2);
	assertEquals(log[1].join(""), "cdefg");

	batch.stop();
});

Deno.test("custom logger receives lifecycle events", async () => {
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
	assertStringIncludes(joined, "start");
	assertStringIncludes(joined, "add");
	assertStringIncludes(joined, "flushThreshold reached");
	assertStringIncludes(joined, "flushing 2 items");

	batch.stop();
});

Deno.test("isRunning reflects start/stop state", () => {
	const batch = new BatchFlusher(
		() => Promise.resolve(true),
		{ flushIntervalMs: 100, maxBatchSize: 10 },
		false // don't autostart
	);

	assertEquals(batch.isRunning, false);

	batch.start();
	assertEquals(batch.isRunning, true);

	batch.stop();
	assertEquals(batch.isRunning, false);
});

Deno.test("drain flushes and stops", async () => {
	const log: string[][] = [];

	const batch = new BatchFlusher<string>(
		(items) => {
			log.push(items);
			return Promise.resolve(true);
		},
		{ flushIntervalMs: 1000, maxBatchSize: 100 }
	);

	assertEquals(batch.isRunning, true);

	batch.add("a");
	batch.add("b");
	batch.add("c");

	assertEquals(log.length, 0);
	assertEquals(batch.size, 3);

	const result = await batch.drain();

	assertEquals(result, true);
	assertEquals(log.length, 1);
	assertEquals(log[0].join(""), "abc");
	assertEquals(batch.size, 0);
	assertEquals(batch.isRunning, false);
});

Deno.test("isFlushing reflects flush state", async () => {
	let flushingDuringCallback = false;

	const batch = new BatchFlusher<string>(
		async () => {
			// Capture isFlushing state during the async callback
			flushingDuringCallback = batch.isFlushing;
			await sleep(10);
			return true;
		},
		{ flushIntervalMs: 0, maxBatchSize: 10 },
		false
	);

	assertEquals(batch.isFlushing, false);

	batch.add("a");
	const flushPromise = batch.flush();

	// Should be flushing now
	assertEquals(batch.isFlushing, true);

	await flushPromise;

	// Should be done flushing
	assertEquals(batch.isFlushing, false);
	assertEquals(flushingDuringCallback, true);
});

Deno.test("subscribe provides reactive state updates", async () => {
	const states: { size: number; isRunning: boolean; isFlushing: boolean }[] =
		[];

	const batch = new BatchFlusher<string>(
		async () => {
			await sleep(10);
			return true;
		},
		{ flushIntervalMs: 0, maxBatchSize: 100 },
		false // don't autostart
	);

	const unsubscribe = batch.subscribe((state) => {
		states.push({ ...state });
	});

	// Initial state should be captured immediately
	assertEquals(states.length, 1);
	assertEquals(states[0], { size: 0, isRunning: false, isFlushing: false });

	// Start should notify
	batch.start();
	assertEquals(states.length, 2);
	assertEquals(states[1].isRunning, true);

	// Add items should notify
	batch.add("a");
	batch.add("b");
	assertEquals(states.length, 4);
	assertEquals(states[3].size, 2);

	// Flush should notify (start and end)
	const flushPromise = batch.flush();
	assertEquals(states.length, 5);
	assertEquals(states[4].isFlushing, true);
	assertEquals(states[4].size, 0);

	await flushPromise;
	assertEquals(states.length, 6);
	assertEquals(states[5].isFlushing, false);

	// Stop should notify
	batch.stop();
	assertEquals(states.length, 7);
	assertEquals(states[6].isRunning, false);

	// Unsubscribe should stop notifications
	unsubscribe();
	batch.add("c");
	assertEquals(states.length, 7); // No new state captured
});

Deno.test("stop during in-flight flush does not resurrect scheduler (B1)", async () => {
	let flushCount = 0;
	const batch = new BatchFlusher<string>(
		async () => {
			flushCount++;
			await sleep(30);
			return true;
		},
		{ flushIntervalMs: 10, maxBatchSize: 10 }
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
	assertEquals(batch.isRunning, false);
	assertEquals(flushCount, 1);
});

Deno.test("double start is idempotent (B2)", async () => {
	let flushCount = 0;
	const batch = new BatchFlusher<string>(
		() => {
			flushCount++;
			return Promise.resolve(true);
		},
		{ flushIntervalMs: 15, maxBatchSize: 10 },
		false
	);

	batch.start();
	batch.start(); // second start — must not create a second timer chain
	batch.start();

	batch.add("a");
	await sleep(40);
	batch.stop();

	// Without the guard, three overlapping timer chains would multiply flushes.
	assertEquals(flushCount <= 3, true, `expected ≤3 flushes, got ${flushCount}`);
});

Deno.test("items are requeued on flusher throw (B3)", async () => {
	let attempts = 0;
	const errors: unknown[] = [];

	const batch = new BatchFlusher<string>(
		async (items) => {
			attempts++;
			if (attempts === 1) throw new Error("transient");
			// Second attempt succeeds
			assertEquals(items.join(""), "ab");
			return true;
		},
		{
			flushIntervalMs: 0,
			maxBatchSize: 10,
			onFlushError: (_items, err) => errors.push(err),
		},
		false
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
	assertEquals(String(caught), "Error: transient");
	assertEquals(errors.length, 1);
	// Items must be back in the buffer for retry.
	assertEquals(batch.dump().join(""), "ab");

	// Second flush succeeds with the requeued items.
	const ok = await batch.flush();
	assertEquals(ok, true);
	assertEquals(attempts, 2);
	assertEquals(batch.size, 0);
});

Deno.test("requeue preserves ordering when new items arrived during flight (B3)", async () => {
	let attempts = 0;
	const batch = new BatchFlusher<string>(
		async (items) => {
			attempts++;
			if (attempts === 1) {
				// Simulate new items arriving during the async flush
				await sleep(10);
				throw new Error("fail");
			}
			return true;
		},
		{ flushIntervalMs: 0, maxBatchSize: 10 },
		false
	);

	batch.add("a");
	batch.add("b");
	const p = batch.flush().catch(() => {});
	// While the flusher is sleeping, add more items
	await sleep(2);
	batch.add("c");
	await p;

	// Requeued [a,b] should be prepended to [c] — order preserved.
	assertEquals(batch.dump().join(""), "abc");
});

Deno.test("works standalone with no logger injected (quiet default)", async () => {
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
			{ flushIntervalMs: 20, maxBatchSize: 10 }
			// no logger — must work with built-in default
		);

		batch.add("a");
		batch.add("b");
		await sleep(40);

		assertEquals(flushed.length, 1);
		assertEquals(flushed[0].join(""), "ab");

		await batch.drain();

		// Default logger should not have emitted anything on the happy path.
		assertEquals(stdoutWarn.length, 0);
		assertEquals(stdoutError.length, 0);
	} finally {
		console.warn = origWarn;
		console.error = origError;
	}
});

Deno.test("concurrent flush calls are serialized (B4)", async () => {
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
		false
	);

	batch.add("a");
	const p1 = batch.flush();
	batch.add("b");
	const p2 = batch.flush();
	batch.add("c");
	const p3 = batch.flush();

	await Promise.all([p1, p2, p3]);

	// Flusher must never run in parallel with itself.
	assertEquals(maxConcurrent, 1);
	// All items must have been processed.
	assertEquals(invocations.flat().sort().join(""), "abc");
});

Deno.test("threshold flush during in-flight flush processes new items (B4)", async () => {
	const batches: string[][] = [];
	const batch = new BatchFlusher<string>(
		async (items) => {
			batches.push([...items]);
			await sleep(15);
			return true;
		},
		{ flushIntervalMs: 0, flushThreshold: 2, maxBatchSize: 100 },
		false
	);

	batch.add("a");
	batch.add("b"); // triggers first flush (in-flight for 15ms)
	// While first flush is running, add more items to trigger a second threshold.
	await sleep(2);
	batch.add("c");
	batch.add("d"); // triggers second flush (queued behind first)
	await sleep(50);

	assertEquals(batches.length, 2);
	assertEquals(batches[0].join(""), "ab");
	assertEquals(batches[1].join(""), "cd");
});

Deno.test("strictFlush in timer path does not produce unhandled rejection (B5)", async () => {
	let unhandled: unknown = undefined;
	const handler = (e: PromiseRejectionEvent | { reason: unknown }) => {
		unhandled = (e as PromiseRejectionEvent).reason ?? (e as { reason: unknown }).reason;
	};
	// Deno treats unhandled rejections as test failures, so if the bug re-appears
	// this test will fail before we check `unhandled`.
	globalThis.addEventListener?.(
		"unhandledrejection",
		handler as EventListener
	);

	const batch = new BatchFlusher<string>(
		() => Promise.reject(new Error("boom")),
		{ flushIntervalMs: 10, maxBatchSize: 10, strictFlush: true }
	);

	batch.add("a");
	await sleep(40);
	batch.stop();
	await sleep(20);

	globalThis.removeEventListener?.(
		"unhandledrejection",
		handler as EventListener
	);
	assertEquals(unhandled, undefined);
});

Deno.test("configure({ logger }) updates active logger (B6)", async () => {
	const logs1: string[] = [];
	const logs2: string[] = [];
	const mk = (sink: string[]): Logger => ({
		debug: (...a) => (sink.push(`d:${a.join(" ")}`), ""),
		log: (...a) => (sink.push(`l:${a.join(" ")}`), ""),
		warn: (...a) => (sink.push(`w:${a.join(" ")}`), ""),
		error: (...a) => (sink.push(`e:${a.join(" ")}`), ""),
	});

	const batch = new BatchFlusher<string>(
		() => Promise.resolve(true),
		{ flushIntervalMs: 0, maxBatchSize: 10, logger: mk(logs1) },
		false
	);
	batch.add("a");
	const before = logs1.length;
	assertEquals(before > 0, true);

	// Swap logger
	batch.configure({ logger: mk(logs2) });
	batch.add("b");

	// logs1 should not have grown
	assertEquals(logs1.length, before);
	// logs2 should have captured the new add
	assertEquals(logs2.length > 0, true);
});

Deno.test("droppedCount and onDrop report lossy overflow (D1)", () => {
	const dropped: string[][] = [];
	const batch = new BatchFlusher<string>(
		() => Promise.resolve(true),
		{
			flushIntervalMs: 0,
			maxBatchSize: 3,
			onDrop: (items) => dropped.push(items),
		},
		false
	);

	"abcde".split("").forEach((c) => batch.add(c));

	assertEquals(batch.dump().join(""), "cde");
	assertEquals(batch.droppedCount, 2);
	assertEquals(dropped.length, 2); // one drop per overflow
	assertEquals(dropped[0].join(""), "a");
	assertEquals(dropped[1].join(""), "b");
});

Deno.test("configure validates numeric inputs (D5)", () => {
	const batch = new BatchFlusher<string>(
		() => Promise.resolve(true),
		{ flushIntervalMs: 0, maxBatchSize: 10 },
		false
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
	assertEquals(threw, 5);

	// Valid values must not throw
	batch.configure({ flushIntervalMs: 0, flushThreshold: 0, maxBatchSize: 1 });
});

Deno.test("reset during in-flight flush suppresses requeue-on-error", async () => {
	const batch = new BatchFlusher<string>(
		async () => {
			await sleep(15);
			throw new Error("fail");
		},
		{ flushIntervalMs: 0, maxBatchSize: 10 },
		false
	);

	batch.add("a");
	batch.add("b");
	const p = batch.flush().catch(() => {});
	await sleep(2);
	// User explicitly cleared the buffer during the flush
	batch.reset();
	await p;

	// Without the reset-generation check, requeue would put [a,b] back.
	assertEquals(batch.size, 0);
});

