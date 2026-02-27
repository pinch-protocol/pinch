/**
 * Unit tests for pinch-intervene argument parsing.
 * Tests the parseArgs function directly (mocking bootstrap is not needed
 * for argument validation).
 */

import { describe, it, expect } from "vitest";
import { parseArgs } from "./pinch-intervene.js";

describe("pinch-intervene parseArgs", () => {
	it("parses --start --connection", () => {
		const result = parseArgs(["--start", "--connection", "pinch:bob@relay"]);
		expect(result.mode).toBe("start");
		expect(result.connection).toBe("pinch:bob@relay");
		expect(result.body).toBeUndefined();
	});

	it("parses --stop --connection", () => {
		const result = parseArgs(["--stop", "--connection", "pinch:bob@relay"]);
		expect(result.mode).toBe("stop");
		expect(result.connection).toBe("pinch:bob@relay");
	});

	it("parses --send --connection --body", () => {
		const result = parseArgs([
			"--send",
			"--connection",
			"pinch:bob@relay",
			"--body",
			"Hello from human",
		]);
		expect(result.mode).toBe("send");
		expect(result.connection).toBe("pinch:bob@relay");
		expect(result.body).toBe("Hello from human");
	});

	it("throws if --connection is missing", () => {
		expect(() => parseArgs(["--start"])).toThrow("--connection is required");
	});

	it("throws if no mode flag is provided", () => {
		expect(() => parseArgs(["--connection", "pinch:bob@relay"])).toThrow(
			"Exactly one of --start, --stop, or --send is required",
		);
	});

	it("throws if multiple mode flags are provided", () => {
		expect(() =>
			parseArgs(["--start", "--stop", "--connection", "pinch:bob@relay"]),
		).toThrow("Exactly one of --start, --stop, or --send is required");
	});

	it("throws if --send without --body", () => {
		expect(() =>
			parseArgs(["--send", "--connection", "pinch:bob@relay"]),
		).toThrow("--body is required with --send");
	});
});
