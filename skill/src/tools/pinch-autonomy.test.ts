import { describe, it, expect } from "vitest";
import { parseArgs } from "./pinch-autonomy.js";

describe("pinch-autonomy parseArgs", () => {
	it("parses all arguments correctly", () => {
		const result = parseArgs([
			"--address",
			"pinch:bob@localhost",
			"--level",
			"auto_respond",
			"--confirmed",
			"--policy",
			"Only respond to scheduling requests",
		]);

		expect(result.address).toBe("pinch:bob@localhost");
		expect(result.level).toBe("auto_respond");
		expect(result.confirmed).toBe(true);
		expect(result.policy).toBe("Only respond to scheduling requests");
	});

	it("throws when --address is missing", () => {
		expect(() =>
			parseArgs(["--level", "full_manual"]),
		).toThrow("--address is required");
	});

	it("throws when --level is missing", () => {
		expect(() =>
			parseArgs(["--address", "pinch:bob@localhost"]),
		).toThrow("--level is required");
	});

	it("throws for invalid --level value", () => {
		expect(() =>
			parseArgs([
				"--address",
				"pinch:bob@localhost",
				"--level",
				"super_auto",
			]),
		).toThrow('Invalid --level: "super_auto"');
	});

	it("parses --policy text", () => {
		const result = parseArgs([
			"--address",
			"pinch:bob@localhost",
			"--level",
			"auto_respond",
			"--policy",
			"Respond to meeting invites and scheduling only",
		]);

		expect(result.policy).toBe(
			"Respond to meeting invites and scheduling only",
		);
	});

	it("defaults confirmed to false when not provided", () => {
		const result = parseArgs([
			"--address",
			"pinch:bob@localhost",
			"--level",
			"notify",
		]);

		expect(result.confirmed).toBe(false);
		expect(result.policy).toBeUndefined();
	});

	it("accepts all 4 valid autonomy levels", () => {
		for (const level of ["full_manual", "notify", "auto_respond", "full_auto"]) {
			const result = parseArgs([
				"--address",
				"pinch:bob@localhost",
				"--level",
				level,
			]);
			expect(result.level).toBe(level);
		}
	});
});
