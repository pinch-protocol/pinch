import { describe, expect, it } from "vitest";
import { isToolEntrypoint, parseConnectionArg } from "./cli.js";

describe("parseConnectionArg", () => {
	it("extracts --connection value", () => {
		expect(
			parseConnectionArg(["--connection", "pinch:abc@relay.host"]),
		).toEqual({
			connection: "pinch:abc@relay.host",
		});
	});

	it("throws when --connection is missing", () => {
		expect(() => parseConnectionArg([])).toThrow("--connection is required");
	});
});

describe("isToolEntrypoint", () => {
	it("matches tool ts/js script names", () => {
		expect(isToolEntrypoint("/tmp/pinch-accept.ts", "pinch-accept")).toBe(true);
		expect(isToolEntrypoint("/tmp/pinch-accept.js", "pinch-accept")).toBe(true);
	});

	it("rejects unrelated scripts", () => {
		expect(isToolEntrypoint("/tmp/pinch-send.js", "pinch-accept")).toBe(false);
		expect(isToolEntrypoint(undefined, "pinch-accept")).toBe(false);
	});
});
