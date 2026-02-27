import { describe, expect, it } from "vitest";
import { parseArgs } from "./pinch-permissions.js";

describe("pinch-permissions parseArgs", () => {
	it("parses --show", () => {
		const result = parseArgs(["--address", "pinch:test@localhost", "--show"]);
		expect(result.address).toBe("pinch:test@localhost");
		expect(result.show).toBe(true);
	});

	it("parses --calendar", () => {
		const result = parseArgs([
			"--address",
			"pinch:test@localhost",
			"--calendar",
			"full_details",
		]);
		expect(result.calendar).toBe("full_details");
	});

	it("parses --files with --folders", () => {
		const result = parseArgs([
			"--address",
			"pinch:test@localhost",
			"--files",
			"specific_folders",
			"--folders",
			"/docs,/photos",
		]);
		expect(result.files).toBe("specific_folders");
		expect(result.folders).toEqual(["/docs", "/photos"]);
	});

	it("parses --actions with --scopes", () => {
		const result = parseArgs([
			"--address",
			"pinch:test@localhost",
			"--actions",
			"scoped",
			"--scopes",
			"schedule_meeting,send_email",
		]);
		expect(result.actions).toBe("scoped");
		expect(result.scopes).toEqual(["schedule_meeting", "send_email"]);
	});

	it("parses spending caps", () => {
		const result = parseArgs([
			"--address",
			"pinch:test@localhost",
			"--spending-per-tx",
			"100",
			"--spending-per-day",
			"500",
			"--spending-per-connection",
			"1000",
		]);
		expect(result.spendingPerTx).toBe(100);
		expect(result.spendingPerDay).toBe(500);
		expect(result.spendingPerConnection).toBe(1000);
	});

	it("parses --add-boundary", () => {
		const result = parseArgs([
			"--address",
			"pinch:test@localhost",
			"--add-boundary",
			"never share my financials",
		]);
		expect(result.addBoundary).toBe("never share my financials");
	});

	it("parses --remove-boundary", () => {
		const result = parseArgs([
			"--address",
			"pinch:test@localhost",
			"--remove-boundary",
			"0",
		]);
		expect(result.removeBoundary).toBe(0);
	});

	it("parses --add-category with description and allowed", () => {
		const result = parseArgs([
			"--address",
			"pinch:test@localhost",
			"--add-category",
			"Recruitment",
			"--category-description",
			"Discussing job offers",
			"--category-allowed",
			"false",
		]);
		expect(result.addCategory).toBe("Recruitment");
		expect(result.categoryDescription).toBe("Discussing job offers");
		expect(result.categoryAllowed).toBe(false);
	});

	it("parses --remove-category", () => {
		const result = parseArgs([
			"--address",
			"pinch:test@localhost",
			"--remove-category",
			"Recruitment",
		]);
		expect(result.removeCategory).toBe("Recruitment");
	});

	it("throws on missing --address", () => {
		expect(() => parseArgs(["--show"])).toThrow("--address is required");
	});

	it("throws on invalid --calendar value", () => {
		expect(() =>
			parseArgs([
				"--address",
				"pinch:test@localhost",
				"--calendar",
				"invalid",
			]),
		).toThrow("Invalid --calendar");
	});

	it("throws on invalid --files value", () => {
		expect(() =>
			parseArgs([
				"--address",
				"pinch:test@localhost",
				"--files",
				"invalid",
			]),
		).toThrow("Invalid --files");
	});

	it("throws on invalid --actions value", () => {
		expect(() =>
			parseArgs([
				"--address",
				"pinch:test@localhost",
				"--actions",
				"invalid",
			]),
		).toThrow("Invalid --actions");
	});
});
