import { describe, it, expect } from "vitest";
import { parseArgs } from "./pinch-audit-export.js";

describe("pinch-audit-export parseArgs", () => {
	it("parses --output path", () => {
		const result = parseArgs(["--output", "/tmp/audit.json"]);
		expect(result.output).toBe("/tmp/audit.json");
		expect(result.since).toBeUndefined();
		expect(result.until).toBeUndefined();
	});

	it("parses --output with --since and --until", () => {
		const result = parseArgs([
			"--since",
			"2026-01-01T00:00:00.000Z",
			"--until",
			"2026-12-31T23:59:59.999Z",
			"--output",
			"/tmp/audit-range.json",
		]);
		expect(result.output).toBe("/tmp/audit-range.json");
		expect(result.since).toBe("2026-01-01T00:00:00.000Z");
		expect(result.until).toBe("2026-12-31T23:59:59.999Z");
	});

	it("parses --output with only --since", () => {
		const result = parseArgs([
			"--since",
			"2026-06-01T00:00:00.000Z",
			"--output",
			"/tmp/audit.json",
		]);
		expect(result.output).toBe("/tmp/audit.json");
		expect(result.since).toBe("2026-06-01T00:00:00.000Z");
		expect(result.until).toBeUndefined();
	});

	it("throws when --output is missing", () => {
		expect(() => parseArgs([])).toThrow("--output is required");
	});

	it("throws when --output is missing with other flags", () => {
		expect(() =>
			parseArgs(["--since", "2026-01-01T00:00:00.000Z"]),
		).toThrow("--output is required");
	});

	it("throws when --output flag has no value", () => {
		expect(() => parseArgs(["--output"])).toThrow(
			"--output requires a file path",
		);
	});
});
