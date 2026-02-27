import { describe, expect, it } from "vitest";
import {
	defaultPermissionsManifest,
	validateManifest,
	type PermissionsManifest,
} from "./permissions-manifest.js";

describe("defaultPermissionsManifest", () => {
	it("returns deny-all values", () => {
		const m = defaultPermissionsManifest();

		expect(m.calendar).toBe("none");
		expect(m.files).toBe("none");
		expect(m.actions).toBe("none");
		expect(m.spending.perTransaction).toBe(0);
		expect(m.spending.perDay).toBe(0);
		expect(m.spending.perConnection).toBe(0);
		expect(m.informationBoundaries).toEqual([]);
		expect(m.customCategories).toEqual([]);
		expect(m.allowedFolders).toBeUndefined();
		expect(m.actionScopes).toBeUndefined();
	});

	it("returns a new object each time (no shared references)", () => {
		const a = defaultPermissionsManifest();
		const b = defaultPermissionsManifest();

		expect(a).not.toBe(b);
		expect(a.spending).not.toBe(b.spending);
		expect(a.informationBoundaries).not.toBe(b.informationBoundaries);
		expect(a.customCategories).not.toBe(b.customCategories);
	});
});

describe("validateManifest", () => {
	it("passes for a valid deny-all manifest", () => {
		const m = defaultPermissionsManifest();
		expect(validateManifest(m)).toEqual([]);
	});

	it("passes for a valid manifest with specific_folders and allowedFolders", () => {
		const m: PermissionsManifest = {
			...defaultPermissionsManifest(),
			files: "specific_folders",
			allowedFolders: ["/documents", "/photos"],
		};
		expect(validateManifest(m)).toEqual([]);
	});

	it("passes for a valid manifest with scoped actions and actionScopes", () => {
		const m: PermissionsManifest = {
			...defaultPermissionsManifest(),
			actions: "scoped",
			actionScopes: ["schedule_meeting", "send_email"],
		};
		expect(validateManifest(m)).toEqual([]);
	});

	it("catches specific_folders with no folders", () => {
		const m: PermissionsManifest = {
			...defaultPermissionsManifest(),
			files: "specific_folders",
		};
		const errors = validateManifest(m);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("allowedFolders");
	});

	it("catches specific_folders with empty folders array", () => {
		const m: PermissionsManifest = {
			...defaultPermissionsManifest(),
			files: "specific_folders",
			allowedFolders: [],
		};
		const errors = validateManifest(m);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("allowedFolders");
	});

	it("catches scoped actions with no scopes", () => {
		const m: PermissionsManifest = {
			...defaultPermissionsManifest(),
			actions: "scoped",
		};
		const errors = validateManifest(m);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("actionScopes");
	});

	it("catches scoped actions with empty scopes array", () => {
		const m: PermissionsManifest = {
			...defaultPermissionsManifest(),
			actions: "scoped",
			actionScopes: [],
		};
		const errors = validateManifest(m);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("actionScopes");
	});

	it("catches negative spending caps", () => {
		const m: PermissionsManifest = {
			...defaultPermissionsManifest(),
			spending: { perTransaction: -1, perDay: -5, perConnection: -10 },
		};
		const errors = validateManifest(m);
		expect(errors.length).toBe(3);
		expect(errors[0]).toContain("perTransaction");
		expect(errors[1]).toContain("perDay");
		expect(errors[2]).toContain("perConnection");
	});

	it("catches a single negative spending cap", () => {
		const m: PermissionsManifest = {
			...defaultPermissionsManifest(),
			spending: { perTransaction: 100, perDay: -1, perConnection: 500 },
		};
		const errors = validateManifest(m);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("perDay");
	});

	it("passes for valid positive spending caps", () => {
		const m: PermissionsManifest = {
			...defaultPermissionsManifest(),
			spending: { perTransaction: 100, perDay: 500, perConnection: 1000 },
		};
		expect(validateManifest(m)).toEqual([]);
	});
});
