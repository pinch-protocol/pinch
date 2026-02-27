/**
 * pinch_autonomy -- Set the autonomy level for a connection.
 *
 * Usage:
 *   pinch-autonomy --address <pinch:address> --level <full_manual|notify|auto_respond|full_auto> [--confirmed] [--policy "text"]
 *
 * Outputs JSON: { "address": "...", "previous_level": "...", "new_level": "...", "policy": "..." }
 */

import { bootstrap, shutdown } from "./cli.js";
import type { AutonomyLevel } from "../connection-store.js";

const VALID_LEVELS: AutonomyLevel[] = [
	"full_manual",
	"notify",
	"auto_respond",
	"full_auto",
];

/** Parse CLI arguments into a structured object. */
export function parseArgs(args: string[]): {
	address: string;
	level: AutonomyLevel;
	confirmed: boolean;
	policy?: string;
} {
	let address = "";
	let level = "";
	let confirmed = false;
	let policy: string | undefined;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--address":
				address = args[++i] ?? "";
				break;
			case "--level":
				level = args[++i] ?? "";
				break;
			case "--confirmed":
				confirmed = true;
				break;
			case "--policy":
				policy = args[++i];
				break;
		}
	}

	if (!address) throw new Error("--address is required");
	if (!level) throw new Error("--level is required");
	if (!VALID_LEVELS.includes(level as AutonomyLevel)) {
		throw new Error(
			`Invalid --level: "${level}". Must be one of: ${VALID_LEVELS.join(", ")}`,
		);
	}

	return {
		address,
		level: level as AutonomyLevel,
		confirmed,
		policy,
	};
}

/** Execute the pinch_autonomy tool. */
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

	const previousLevel = connection.autonomyLevel;

	// Gate: upgrading to full_auto requires --confirmed flag
	if (
		parsed.level === "full_auto" &&
		previousLevel !== "full_auto" &&
		!parsed.confirmed
	) {
		console.log(
			JSON.stringify({
				error:
					"Upgrading to full_auto requires --confirmed flag. This gives the agent full autonomy over this connection.",
			}),
		);
		await shutdown();
		return;
	}

	connectionStore.setAutonomy(parsed.address, parsed.level, {
		confirmed: parsed.confirmed,
	});

	// Store policy if provided and level is auto_respond
	if (parsed.policy && parsed.level === "auto_respond") {
		connectionStore.updateConnection(parsed.address, {
			autoRespondPolicy: parsed.policy,
		});
	}

	await connectionStore.save();

	const result: Record<string, string> = {
		address: parsed.address,
		previous_level: previousLevel,
		new_level: parsed.level,
	};

	if (parsed.policy) {
		result.policy = parsed.policy;
	}

	console.log(JSON.stringify(result));
	await shutdown();
}

// Self-executable entry point.
if (
	process.argv[1] &&
	(process.argv[1].endsWith("pinch-autonomy.ts") ||
		process.argv[1].endsWith("pinch-autonomy.js"))
) {
	run(process.argv.slice(2)).catch((err) => {
		console.error(JSON.stringify({ error: String(err.message ?? err) }));
		process.exit(1);
	});
}
