/**
 * Unit tests for pinch-history argument parsing, pinch-status argument
 * parsing, and pinch-contacts argument parsing.
 */

import { describe, it, expect } from "vitest";
import { parseArgs as parseHistoryArgs } from "./pinch-history.js";
import { parseArgs as parseStatusArgs } from "./pinch-status.js";
import { parseArgs as parseContactsArgs } from "./pinch-contacts.js";
import { parseArgs as parseConnectArgs } from "./pinch-connect.js";

describe("pinch-history parseArgs", () => {
	it("returns defaults with no args", () => {
		const result = parseHistoryArgs([]);
		expect(result.connection).toBeUndefined();
		expect(result.thread).toBeUndefined();
		expect(result.limit).toBe(20);
		expect(result.offset).toBe(0);
	});

	it("parses --connection and --thread", () => {
		const result = parseHistoryArgs([
			"--connection", "pinch:bob@relay",
			"--thread", "t-123",
		]);
		expect(result.connection).toBe("pinch:bob@relay");
		expect(result.thread).toBe("t-123");
	});

	it("parses --limit and --offset", () => {
		const result = parseHistoryArgs(["--limit", "50", "--offset", "10"]);
		expect(result.limit).toBe(50);
		expect(result.offset).toBe(10);
	});

	it("ignores invalid numeric values", () => {
		const result = parseHistoryArgs(["--limit", "abc", "--offset", "-5"]);
		expect(result.limit).toBe(20);
		expect(result.offset).toBe(0);
	});
});

describe("pinch-status parseArgs", () => {
	it("parses --id", () => {
		const result = parseStatusArgs(["--id", "msg-abc-123"]);
		expect(result.id).toBe("msg-abc-123");
	});

	it("throws if --id is missing", () => {
		expect(() => parseStatusArgs([])).toThrow("--id is required");
	});
});

describe("pinch-contacts parseArgs", () => {
	it("returns no filter with no args", () => {
		const result = parseContactsArgs([]);
		expect(result.state).toBeUndefined();
	});

	it("parses --state filter", () => {
		const result = parseContactsArgs(["--state", "active"]);
		expect(result.state).toBe("active");
	});

	it("accepts all valid states", () => {
		for (const s of [
			"active",
			"pending_inbound",
			"pending_outbound",
			"blocked",
			"revoked",
		]) {
			const result = parseContactsArgs(["--state", s]);
			expect(result.state).toBe(s);
		}
	});

	it("ignores invalid state value", () => {
		const result = parseContactsArgs(["--state", "invalid"]);
		expect(result.state).toBeUndefined();
	});
});

describe("pinch-connect parseArgs", () => {
	it("parses --to and --message", () => {
		const result = parseConnectArgs(["--to", "pinch:bob@relay", "--message", "Hi"]);
		expect(result.to).toBe("pinch:bob@relay");
		expect(result.message).toBe("Hi");
	});

	it("throws if --to is missing", () => {
		expect(() => parseConnectArgs(["--message", "Hi"])).toThrow(
			"--to is required",
		);
	});

	it("throws if --message is missing", () => {
		expect(() => parseConnectArgs(["--to", "pinch:bob@relay"])).toThrow(
			"--message is required",
		);
	});
});
