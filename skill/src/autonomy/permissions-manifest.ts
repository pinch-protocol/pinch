/**
 * Permissions manifest defines domain-specific capability tiers for a connection.
 *
 * Every new connection gets a deny-all default manifest (Pinch core principle).
 * The manifest defines WHAT each connection can do, while autonomy defines HOW
 * messages are processed. Together they create the graduated trust model.
 */

/** Calendar permission tiers (structural -- no LLM needed). */
export type CalendarPermission = "none" | "free_busy_only" | "full_details" | "propose_and_book";

/** File permission tiers (structural). */
export type FilePermission = "none" | "specific_folders" | "everything";

/** Action permission (structural). */
export type ActionPermission = "none" | "scoped" | "full";

/** Spending caps in USD. 0 = disabled/blocked. */
export interface SpendingCaps {
	perTransaction: number;
	perDay: number;
	perConnection: number;
}

/** User-defined category (LLM-interpreted). */
export interface CustomCategory {
	name: string;
	description: string; // Natural language rule
	allowed: boolean; // Default posture for this category
}

/** The complete permissions manifest for a connection. */
export interface PermissionsManifest {
	calendar: CalendarPermission;
	files: FilePermission;
	allowedFolders?: string[]; // Only when files === 'specific_folders'
	actions: ActionPermission;
	actionScopes?: string[]; // Only when actions === 'scoped'
	spending: SpendingCaps;
	informationBoundaries: string[]; // Natural language exclusions, LLM-evaluated
	customCategories: CustomCategory[];
}

/** Returns a deny-all manifest (Pinch core principle: deny-by-default). */
export function defaultPermissionsManifest(): PermissionsManifest {
	return {
		calendar: "none",
		files: "none",
		actions: "none",
		spending: { perTransaction: 0, perDay: 0, perConnection: 0 },
		informationBoundaries: [],
		customCategories: [],
	};
}

/**
 * Validate a permissions manifest, returning an array of error strings.
 * An empty array means the manifest is valid.
 */
export function validateManifest(m: PermissionsManifest): string[] {
	const errors: string[] = [];

	if (m.files === "specific_folders" && (!m.allowedFolders || m.allowedFolders.length === 0)) {
		errors.push("files is 'specific_folders' but allowedFolders is empty or undefined");
	}

	if (m.actions === "scoped" && (!m.actionScopes || m.actionScopes.length === 0)) {
		errors.push("actions is 'scoped' but actionScopes is empty or undefined");
	}

	if (m.spending.perTransaction < 0) {
		errors.push("spending.perTransaction must not be negative");
	}
	if (m.spending.perDay < 0) {
		errors.push("spending.perDay must not be negative");
	}
	if (m.spending.perConnection < 0) {
		errors.push("spending.perConnection must not be negative");
	}

	return errors;
}
