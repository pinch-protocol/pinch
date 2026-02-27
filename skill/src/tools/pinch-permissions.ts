/**
 * pinch_permissions -- View and configure the permissions manifest for a connection.
 *
 * Usage:
 *   pinch-permissions --address <pinch:address> --show
 *   pinch-permissions --address <pinch:address> --calendar <none|free_busy_only|full_details|propose_and_book>
 *   pinch-permissions --address <pinch:address> --files <none|specific_folders|everything> [--folders "folder1,folder2"]
 *   pinch-permissions --address <pinch:address> --actions <none|scoped|full> [--scopes "scope1,scope2"]
 *   pinch-permissions --address <pinch:address> --spending-per-tx <number> --spending-per-day <number> --spending-per-connection <number>
 *   pinch-permissions --address <pinch:address> --add-boundary "never share my financials"
 *   pinch-permissions --address <pinch:address> --remove-boundary <index>
 *   pinch-permissions --address <pinch:address> --add-category "Recruitment" --category-description "Discussing job offers" --category-allowed false
 *   pinch-permissions --address <pinch:address> --remove-category "Recruitment"
 *
 * Outputs JSON: { "address": "...", "permissions": { ...manifest } } for --show
 *               { "address": "...", "updated": { ...manifest } } for modifications
 *               { "error": "..." } for errors
 */

import { bootstrap, shutdown } from "./cli.js";
import type {
	CalendarPermission,
	FilePermission,
	ActionPermission,
} from "../autonomy/permissions-manifest.js";
import { defaultPermissionsManifest } from "../autonomy/permissions-manifest.js";

const VALID_CALENDAR: CalendarPermission[] = [
	"none",
	"free_busy_only",
	"full_details",
	"propose_and_book",
];
const VALID_FILES: FilePermission[] = ["none", "specific_folders", "everything"];
const VALID_ACTIONS: ActionPermission[] = ["none", "scoped", "full"];

export interface ParsedArgs {
	address: string;
	show: boolean;
	calendar?: CalendarPermission;
	files?: FilePermission;
	folders?: string[];
	actions?: ActionPermission;
	scopes?: string[];
	spendingPerTx?: number;
	spendingPerDay?: number;
	spendingPerConnection?: number;
	addBoundary?: string;
	removeBoundary?: number;
	addCategory?: string;
	categoryDescription?: string;
	categoryAllowed?: boolean;
	removeCategory?: string;
}

/** Parse CLI arguments into a structured object. */
export function parseArgs(args: string[]): ParsedArgs {
	let address = "";
	let show = false;
	let calendar: CalendarPermission | undefined;
	let files: FilePermission | undefined;
	let folders: string[] | undefined;
	let actions: ActionPermission | undefined;
	let scopes: string[] | undefined;
	let spendingPerTx: number | undefined;
	let spendingPerDay: number | undefined;
	let spendingPerConnection: number | undefined;
	let addBoundary: string | undefined;
	let removeBoundary: number | undefined;
	let addCategory: string | undefined;
	let categoryDescription: string | undefined;
	let categoryAllowed: boolean | undefined;
	let removeCategory: string | undefined;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--address":
				address = args[++i] ?? "";
				break;
			case "--show":
				show = true;
				break;
			case "--calendar": {
				const val = args[++i] ?? "";
				if (!VALID_CALENDAR.includes(val as CalendarPermission)) {
					throw new Error(
						`Invalid --calendar: "${val}". Must be one of: ${VALID_CALENDAR.join(", ")}`,
					);
				}
				calendar = val as CalendarPermission;
				break;
			}
			case "--files": {
				const val = args[++i] ?? "";
				if (!VALID_FILES.includes(val as FilePermission)) {
					throw new Error(
						`Invalid --files: "${val}". Must be one of: ${VALID_FILES.join(", ")}`,
					);
				}
				files = val as FilePermission;
				break;
			}
			case "--folders":
				folders = (args[++i] ?? "").split(",").map((f) => f.trim());
				break;
			case "--actions": {
				const val = args[++i] ?? "";
				if (!VALID_ACTIONS.includes(val as ActionPermission)) {
					throw new Error(
						`Invalid --actions: "${val}". Must be one of: ${VALID_ACTIONS.join(", ")}`,
					);
				}
				actions = val as ActionPermission;
				break;
			}
			case "--scopes":
				scopes = (args[++i] ?? "").split(",").map((s) => s.trim());
				break;
			case "--spending-per-tx":
				spendingPerTx = Number(args[++i]);
				break;
			case "--spending-per-day":
				spendingPerDay = Number(args[++i]);
				break;
			case "--spending-per-connection":
				spendingPerConnection = Number(args[++i]);
				break;
			case "--add-boundary":
				addBoundary = args[++i];
				break;
			case "--remove-boundary":
				removeBoundary = Number(args[++i]);
				break;
			case "--add-category":
				addCategory = args[++i];
				break;
			case "--category-description":
				categoryDescription = args[++i];
				break;
			case "--category-allowed": {
				const val = args[++i] ?? "";
				categoryAllowed = val === "true";
				break;
			}
			case "--remove-category":
				removeCategory = args[++i];
				break;
		}
	}

	if (!address) throw new Error("--address is required");

	return {
		address,
		show,
		calendar,
		files,
		folders,
		actions,
		scopes,
		spendingPerTx,
		spendingPerDay,
		spendingPerConnection,
		addBoundary,
		removeBoundary,
		addCategory,
		categoryDescription,
		categoryAllowed,
		removeCategory,
	};
}

/** Execute the pinch_permissions tool. */
export async function run(args: string[]): Promise<void> {
	const parsed = parseArgs(args);
	const { connectionStore } = await bootstrap();

	const connection = connectionStore.getConnection(parsed.address);
	if (!connection) {
		console.log(
			JSON.stringify({ error: `Connection not found: ${parsed.address}` }),
		);
		await shutdown();
		return;
	}

	// Show current permissions.
	if (parsed.show) {
		const manifest =
			connection.permissionsManifest ?? defaultPermissionsManifest();
		console.log(
			JSON.stringify({
				address: parsed.address,
				permissions: manifest,
			}),
		);
		await shutdown();
		return;
	}

	// Build updated manifest from current state.
	const manifest =
		connection.permissionsManifest ?? defaultPermissionsManifest();

	// Apply modifications.
	if (parsed.calendar !== undefined) {
		manifest.calendar = parsed.calendar;
	}
	if (parsed.files !== undefined) {
		manifest.files = parsed.files;
	}
	if (parsed.folders !== undefined) {
		manifest.allowedFolders = parsed.folders;
	}
	if (parsed.actions !== undefined) {
		manifest.actions = parsed.actions;
	}
	if (parsed.scopes !== undefined) {
		manifest.actionScopes = parsed.scopes;
	}
	if (parsed.spendingPerTx !== undefined) {
		manifest.spending.perTransaction = parsed.spendingPerTx;
	}
	if (parsed.spendingPerDay !== undefined) {
		manifest.spending.perDay = parsed.spendingPerDay;
	}
	if (parsed.spendingPerConnection !== undefined) {
		manifest.spending.perConnection = parsed.spendingPerConnection;
	}

	// Information boundaries.
	if (parsed.addBoundary !== undefined) {
		manifest.informationBoundaries.push(parsed.addBoundary);
	}
	if (parsed.removeBoundary !== undefined) {
		if (
			parsed.removeBoundary >= 0 &&
			parsed.removeBoundary < manifest.informationBoundaries.length
		) {
			manifest.informationBoundaries.splice(parsed.removeBoundary, 1);
		}
	}

	// Custom categories.
	if (parsed.addCategory !== undefined && parsed.categoryDescription !== undefined) {
		manifest.customCategories.push({
			name: parsed.addCategory,
			description: parsed.categoryDescription,
			allowed: parsed.categoryAllowed ?? false,
		});
	}
	if (parsed.removeCategory !== undefined) {
		manifest.customCategories = manifest.customCategories.filter(
			(c) => c.name !== parsed.removeCategory,
		);
	}

	// Validate and save.
	try {
		connectionStore.setPermissions(parsed.address, manifest);
		await connectionStore.save();
		console.log(
			JSON.stringify({ address: parsed.address, updated: manifest }),
		);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(JSON.stringify({ error: msg }));
	}

	await shutdown();
}

// Self-executable entry point.
if (
	process.argv[1] &&
	(process.argv[1].endsWith("pinch-permissions.ts") ||
		process.argv[1].endsWith("pinch-permissions.js"))
) {
	run(process.argv.slice(2)).catch((err) => {
		console.error(JSON.stringify({ error: String(err.message ?? err) }));
		process.exit(1);
	});
}
