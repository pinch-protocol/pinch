import { describe, it, expect } from "vitest";
import { parseArgs } from "./pinch-activity.js";

describe("pinch-activity parseArgs", () => {
	it("returns defaults with no args", () => {
		const result = parseArgs([]);
		expect(result.connection).toBeUndefined();
		expect(result.type).toBeUndefined();
		expect(result.since).toBeUndefined();
		expect(result.until).toBeUndefined();
		expect(result.limit).toBe(50);
		expect(result.includeMuted).toBe(false);
	});

	it("parses --connection", () => {
		const result = parseArgs(["--connection", "pinch:bob@relay"]);
		expect(result.connection).toBe("pinch:bob@relay");
	});

	it("parses --type", () => {
		const result = parseArgs(["--type", "message_send"]);
		expect(result.type).toBe("message_send");
	});

	it("parses --since and --until timestamps", () => {
		const result = parseArgs([
			"--since",
			"2026-02-27T00:00:00.000Z",
			"--until",
			"2026-02-28T00:00:00.000Z",
		]);
		expect(result.since).toBe("2026-02-27T00:00:00.000Z");
		expect(result.until).toBe("2026-02-28T00:00:00.000Z");
	});

	it("parses --limit", () => {
		const result = parseArgs(["--limit", "25"]);
		expect(result.limit).toBe(25);
	});

	it("ignores invalid limit values", () => {
		const result = parseArgs(["--limit", "abc"]);
		expect(result.limit).toBe(50);
	});

	it("ignores non-positive limit values", () => {
		const result = parseArgs(["--limit", "0"]);
		expect(result.limit).toBe(50);
	});

	it("parses --include-muted flag", () => {
		const result = parseArgs(["--include-muted"]);
		expect(result.includeMuted).toBe(true);
	});

	it("defaults includeMuted to false without flag", () => {
		const result = parseArgs(["--connection", "pinch:bob@relay"]);
		expect(result.includeMuted).toBe(false);
	});

	it("parses all flags together", () => {
		const result = parseArgs([
			"--connection",
			"pinch:alice@relay",
			"--type",
			"connection_approve",
			"--since",
			"2026-01-01T00:00:00.000Z",
			"--until",
			"2026-12-31T23:59:59.999Z",
			"--limit",
			"10",
			"--include-muted",
		]);
		expect(result.connection).toBe("pinch:alice@relay");
		expect(result.type).toBe("connection_approve");
		expect(result.since).toBe("2026-01-01T00:00:00.000Z");
		expect(result.until).toBe("2026-12-31T23:59:59.999Z");
		expect(result.limit).toBe(10);
		expect(result.includeMuted).toBe(true);
	});
});
