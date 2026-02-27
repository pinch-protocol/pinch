import { describe, it, expect } from "vitest";
import { parseArgs } from "./pinch-audit-verify.js";

describe("pinch-audit-verify parseArgs", () => {
	it("returns defaults with no args (verify all)", () => {
		const result = parseArgs([]);
		expect(result.tail).toBeUndefined();
	});

	it("parses --tail with a valid number", () => {
		const result = parseArgs(["--tail", "100"]);
		expect(result.tail).toBe(100);
	});

	it("parses --tail 1", () => {
		const result = parseArgs(["--tail", "1"]);
		expect(result.tail).toBe(1);
	});

	it("throws when --tail is missing a number", () => {
		expect(() => parseArgs(["--tail"])).toThrow("--tail requires a number");
	});

	it("throws when --tail has a non-numeric value", () => {
		expect(() => parseArgs(["--tail", "abc"])).toThrow(
			"--tail requires a positive number",
		);
	});

	it("throws when --tail has zero", () => {
		expect(() => parseArgs(["--tail", "0"])).toThrow(
			"--tail requires a positive number",
		);
	});

	it("throws when --tail has negative value", () => {
		expect(() => parseArgs(["--tail", "-5"])).toThrow(
			"--tail requires a positive number",
		);
	});
});
