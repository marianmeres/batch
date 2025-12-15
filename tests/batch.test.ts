import { BatchFlusher } from "../src/batch.ts";
import { createClog, type Logger } from "@marianmeres/clog";
import { sleep } from "./sleep.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";

createClog.global.debug = false;

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

Deno.test("debug mode logs events", async () => {
	const debugLogs: string[] = [];

	const mockLogger: Logger = {
		debug: (...args: unknown[]) => {
			debugLogs.push(args.join(" "));
			return "";
		},
		log: () => "",
		warn: () => "",
		error: () => "",
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

	// Should have logged: start, add, add, threshold reached, flushing, flush complete
	assertStringIncludes(debugLogs.join("|"), "start");
	assertStringIncludes(debugLogs.join("|"), "add");
	assertStringIncludes(debugLogs.join("|"), "flushThreshold reached");
	assertStringIncludes(debugLogs.join("|"), "flushing 2 items");

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
