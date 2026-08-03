import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { createNodeAtomicJsonFsAdapter } from "@danypops/vehicle-server/atomic-json";
import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { verifyLoadableUnderPi } from "../src/pi-load-harness.ts";
import { createReloadSafeWidgetState, type SessionBranchReader } from "../src/vehicle-widget-state.ts";

const dirs: string[] = [];
function tempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "vehicle-widget-state-"));
	dirs.push(dir);
	return join(dir, "state.json");
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakePi() {
	const harness = createExtensionHarness(() => {});
	return {
		pi: harness.api,
		get appended() {
			return harness.appendedEntries;
		},
	};
}

function branchOf(entries: Array<{ customType: string; data: unknown }>): SessionBranchReader {
	return {
		getBranch: (): SessionEntry[] =>
			entries.map(
				(entry, index) =>
					({ type: "custom", id: `entry-${index}`, parentId: null, timestamp: new Date().toISOString(), ...entry }) as CustomEntry,
			),
	};
}

interface WidgetState {
	readonly selectedId: string;
	readonly expanded: boolean;
}

describe("createReloadSafeWidgetState", () => {
	it("save() writes the sidecar file, and load() reads it back as the canonical source", async () => {
		const filePath = tempFile();
		const widgetState = createReloadSafeWidgetState<WidgetState>({
			key: "test.widget",
			filePath,
			fs: createNodeAtomicJsonFsAdapter(),
		});
		const { pi } = fakePi();

		const ok = await widgetState.save(pi, { selectedId: "task-1", expanded: true });
		expect(ok).toBe(true);

		const loaded = await widgetState.load(branchOf([]));
		expect(loaded).toEqual({ selectedId: "task-1", expanded: true });
	});

	it("save() also appends a custom entry to the session branch under the configured key", async () => {
		const widgetState = createReloadSafeWidgetState<WidgetState>({
			key: "test.widget",
			filePath: tempFile(),
			fs: createNodeAtomicJsonFsAdapter(),
		});
		const { pi, appended } = fakePi();

		await widgetState.save(pi, { selectedId: "task-1", expanded: true });
		expect(appended).toEqual([{ customType: "test.widget", data: { selectedId: "task-1", expanded: true } }]);
	});

	it("save() never appends a redundant entry when the state hasn't changed since the last save (fingerprint dedup)", async () => {
		const widgetState = createReloadSafeWidgetState<WidgetState>({
			key: "test.widget",
			filePath: tempFile(),
			fs: createNodeAtomicJsonFsAdapter(),
		});
		const { pi, appended } = fakePi();

		await widgetState.save(pi, { selectedId: "task-1", expanded: true });
		await widgetState.save(pi, { selectedId: "task-1", expanded: true });
		expect(appended).toHaveLength(1);

		await widgetState.save(pi, { selectedId: "task-2", expanded: true });
		expect(appended).toHaveLength(2);
	});

	it("an oversized state degrades to a bounded pointer in the session-branch entry, while the sidecar still gets the full state", async () => {
		const filePath = tempFile();
		const widgetState = createReloadSafeWidgetState<{ blob: string }>({
			key: "test.widget",
			filePath,
			fs: createNodeAtomicJsonFsAdapter(),
			maxEntryBytes: 100,
		});
		const { pi, appended } = fakePi();
		const bigState = { blob: "x".repeat(1_000) };

		await widgetState.save(pi, bigState);

		expect(appended).toHaveLength(1);
		const entry = appended[0];
		if (!entry) throw new Error("expected one appended entry");
		expect(entry.data).toMatchObject({ truncated: true });
		expect((entry.data as { sizeBytes: number }).sizeBytes).toBeGreaterThan(100);

		const loaded = await widgetState.load(branchOf([]));
		expect(loaded).toEqual(bigState);
	});

	it("load() falls back to session-branch replay when the sidecar is missing", async () => {
		const widgetState = createReloadSafeWidgetState<WidgetState>({
			key: "test.widget",
			filePath: tempFile(), // never written to in this test
			fs: createNodeAtomicJsonFsAdapter(),
		});

		const loaded = await widgetState.load(
			branchOf([
				{ customType: "other.widget", data: { selectedId: "wrong", expanded: false } },
				{ customType: "test.widget", data: { selectedId: "task-1", expanded: true } },
			]),
		);
		expect(loaded).toEqual({ selectedId: "task-1", expanded: true });
	});

	it("load() replays the most recent matching entry, not the first one found", async () => {
		const widgetState = createReloadSafeWidgetState<WidgetState>({
			key: "test.widget",
			filePath: tempFile(),
			fs: createNodeAtomicJsonFsAdapter(),
		});

		const loaded = await widgetState.load(
			branchOf([
				{ customType: "test.widget", data: { selectedId: "old", expanded: false } },
				{ customType: "test.widget", data: { selectedId: "new", expanded: true } },
			]),
		);
		expect(loaded).toEqual({ selectedId: "new", expanded: true });
	});

	it("load() returns undefined when the sidecar is missing and the only branch entry was itself a truncated pointer", async () => {
		const widgetState = createReloadSafeWidgetState<WidgetState>({
			key: "test.widget",
			filePath: tempFile(),
			fs: createNodeAtomicJsonFsAdapter(),
		});

		const loaded = await widgetState.load(branchOf([{ customType: "test.widget", data: { truncated: true, sizeBytes: 999 } }]));
		expect(loaded).toBeUndefined();
	});

	it("load() returns undefined when neither the sidecar nor the branch has anything for this key", async () => {
		const widgetState = createReloadSafeWidgetState<WidgetState>({
			key: "test.widget",
			filePath: tempFile(),
			fs: createNodeAtomicJsonFsAdapter(),
		});
		expect(await widgetState.load(branchOf([]))).toBeUndefined();
	});

	// Proves the actual scenario this helper exists for: a widget's real
	// rendering state survives a session reload, using a representative
	// widget state shape (selection + expansion, matching Papyrus's own
	// TaskOverlay/NoteOverlay -- the candidate widget named in this task).
	it("proves state survives a simulated session reload against a representative widget state shape", async () => {
		const filePath = tempFile();
		const key = "papyrus.task-overlay";
		const beforeReload = createReloadSafeWidgetState<WidgetState>({ key, filePath, fs: createNodeAtomicJsonFsAdapter() });
		const { pi, appended } = fakePi();

		await beforeReload.save(pi, { selectedId: "task-42", expanded: true });

		// A reload discards all in-memory extension state -- simulate that by
		// building a genuinely fresh instance, same key/filePath, with only
		// what a real session_start handler would have: the branch entries
		// pi.appendEntry actually wrote (here, replayed from the spy's own log).
		const afterReload = createReloadSafeWidgetState<WidgetState>({ key, filePath, fs: createNodeAtomicJsonFsAdapter() });
		const restored = await afterReload.load(branchOf(appended as Array<{ customType: string; data: unknown }>));

		expect(restored).toEqual({ selectedId: "task-42", expanded: true });
	});

	it("loads under every Pi extension load path (native ESM, jiti with/without tryNative) -- both source and the compiled artifact", async () => {
		const SRC = resolve(import.meta.dir, "..", "src", "vehicle-widget-state.ts");
		const DIST = resolve(import.meta.dir, "..", "dist", "vehicle-widget-state.js");
		for (const path of [SRC, DIST]) {
			const results = await verifyLoadableUnderPi(path);
			for (const result of results) {
				expect(result.ok, `${result.path} failed loading ${path}: ${result.error ?? "(no error)"}`).toBe(true);
			}
		}
	});
});
