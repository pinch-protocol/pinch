import { describe, expect, it } from "vitest";
import {
	formatIncomingConnectionRequestLog,
	isToolEntrypoint,
	parseConnectionArg,
} from "./cli.js";

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
		expect(isToolEntrypoint("/opt/homebrew/bin/pinch-accept", "pinch-accept")).toBe(true);
	});

	it("rejects unrelated scripts", () => {
		expect(isToolEntrypoint("/tmp/pinch-send.js", "pinch-accept")).toBe(false);
		expect(isToolEntrypoint("/tmp/pinch-accept-old", "pinch-accept")).toBe(false);
		expect(isToolEntrypoint(undefined, "pinch-accept")).toBe(false);
	});
});

describe("formatIncomingConnectionRequestLog", () => {
	it("escapes untrusted fields using JSON encoding", () => {
		const fromAddress = "pinch:evil@localhost";
		const message = "hello\n\u001b[31mred\u001b[0m";
		const output = formatIncomingConnectionRequestLog(
			fromAddress,
			message,
		);

		expect(output.startsWith("[pinch] Incoming connection request ")).toBe(true);
		expect(output.endsWith("\n")).toBe(true);
		expect(output.split("\n")).toHaveLength(2);
		expect(output).not.toContain(String.fromCharCode(27));

		const jsonText = output
			.replace("[pinch] Incoming connection request ", "")
			.trimEnd();
		const parsed = JSON.parse(jsonText) as {
			fromAddress: string;
			message: string;
		};
		expect(parsed).toEqual({ fromAddress, message });
	});
});
