/**
 * Unit tests for pinch-mute argument parsing.
 * Tests the parseArgs function directly (mocking bootstrap is not needed
 * for argument validation).
 */

import { describe, it, expect } from "vitest";
import { parseArgs } from "./pinch-mute.js";

describe("pinch-mute parseArgs", () => {
	it("parses --connection for mute (default)", () => {
		const result = parseArgs(["--connection", "pinch:bob@relay"]);
		expect(result.connection).toBe("pinch:bob@relay");
		expect(result.unmute).toBe(false);
	});

	it("parses --unmute --connection", () => {
		const result = parseArgs([
			"--unmute",
			"--connection",
			"pinch:bob@relay",
		]);
		expect(result.connection).toBe("pinch:bob@relay");
		expect(result.unmute).toBe(true);
	});

	it("throws if --connection is missing", () => {
		expect(() => parseArgs([])).toThrow("--connection is required");
	});

	it("throws if --connection is missing with --unmute", () => {
		expect(() => parseArgs(["--unmute"])).toThrow(
			"--connection is required",
		);
	});
});
