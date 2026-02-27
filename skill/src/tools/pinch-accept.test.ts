/**
 * Unit tests for pinch-accept argument parsing.
 * Tests the parseArgs function directly (mocking bootstrap is not needed
 * for argument validation).
 */

import { describe, it, expect } from "vitest";
import { parseArgs } from "./pinch-accept.js";

describe("pinch-accept parseArgs", () => {
	it("parses --connection correctly", () => {
		const result = parseArgs(["--connection", "pinch:abc@relay.host"]);
		expect(result.connection).toBe("pinch:abc@relay.host");
	});

	it("throws if --connection is missing", () => {
		expect(() => parseArgs([])).toThrow("--connection is required");
	});
});
