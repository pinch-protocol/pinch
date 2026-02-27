/**
 * Unit tests for pinch-send argument parsing and output formatting.
 * Tests the parseArgs function directly (mocking bootstrap is not needed
 * for argument validation).
 */

import { describe, it, expect } from "vitest";
import { parseArgs } from "./pinch-send.js";

describe("pinch-send parseArgs", () => {
	it("parses required --to and --body args", () => {
		const result = parseArgs(["--to", "pinch:bob@relay", "--body", "Hello Bob"]);
		expect(result.to).toBe("pinch:bob@relay");
		expect(result.body).toBe("Hello Bob");
		expect(result.thread).toBeUndefined();
		expect(result.replyTo).toBeUndefined();
		expect(result.priority).toBeUndefined();
	});

	it("parses optional --thread, --reply-to, --priority", () => {
		const result = parseArgs([
			"--to", "pinch:bob@relay",
			"--body", "Hello",
			"--thread", "thread-123",
			"--reply-to", "msg-456",
			"--priority", "urgent",
		]);
		expect(result.thread).toBe("thread-123");
		expect(result.replyTo).toBe("msg-456");
		expect(result.priority).toBe("urgent");
	});

	it("throws if --to is missing", () => {
		expect(() => parseArgs(["--body", "Hello"])).toThrow("--to is required");
	});

	it("throws if --body is missing", () => {
		expect(() => parseArgs(["--to", "pinch:bob@relay"])).toThrow(
			"--body is required",
		);
	});

	it("accepts all priority levels", () => {
		for (const p of ["low", "normal", "urgent"] as const) {
			const result = parseArgs([
				"--to", "pinch:bob@relay",
				"--body", "Hello",
				"--priority", p,
			]);
			expect(result.priority).toBe(p);
		}
	});

	it("ignores invalid priority value", () => {
		const result = parseArgs([
			"--to", "pinch:bob@relay",
			"--body", "Hello",
			"--priority", "invalid",
		]);
		expect(result.priority).toBeUndefined();
	});
});
