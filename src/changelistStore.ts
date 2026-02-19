import * as fs from 'fs';
import * as path from 'path';

/** JSON shape of cl.json: mapping of changelist name → file paths */
export type ChangelistData = Record<string, string[]>;

/** Reserved git ref names that cannot be used as changelist names */
const GIT_RESERVED_WORDS = new Set([
	'HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD',
	'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_HEAD',
	'stash', 'refs', 'objects', 'packed-refs',
]);

/** Pattern for valid changelist names: alphanumeric, hyphens, underscores, dots */
const VALID_NAME_RE = /^[a-zA-Z0-9._-]+$/;

const MAX_NAME_LENGTH = 100;

/**
 * Validate a changelist name.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateChangelistName(name: string): string | null {
	if (!name || name.length === 0) {
		return 'Changelist name cannot be empty';
	}
	if (name.length > MAX_NAME_LENGTH) {
		return `Changelist name must be at most ${MAX_NAME_LENGTH} characters`;
	}
	if (!VALID_NAME_RE.test(name)) {
		return 'Changelist name may only contain alphanumeric characters, hyphens, underscores, and dots';
	}
	if (GIT_RESERVED_WORDS.has(name)) {
		return `"${name}" is a reserved git name and cannot be used as a changelist name`;
	}
	return null;
}

/**
 * Sanitize and validate a file path relative to the git root.
 * Returns the normalized relative path, or throws on invalid input.
 */
export function sanitizeFilePath(filePath: string, gitRoot: string): string {
	if (!filePath || filePath.length === 0) {
		throw new Error('File path cannot be empty');
	}

	// Reject absolute paths
	if (path.isAbsolute(filePath)) {
		throw new Error(`Absolute paths are not allowed: ${filePath}`);
	}

	// Normalize and resolve
	const normalized = path.normalize(filePath);

	// Reject path traversal
	if (normalized.startsWith('..') || normalized.includes(`${path.sep}..${path.sep}`) || normalized.endsWith(`${path.sep}..`)) {
		throw new Error(`Path traversal is not allowed: ${filePath}`);
	}

	// Reject unsafe characters (null bytes, control chars)
	if (/[\x00-\x1f]/.test(filePath)) {
		throw new Error(`Unsafe characters in path: ${filePath}`);
	}

	// Ensure resolved path stays within git root
	const resolved = path.resolve(gitRoot, normalized);
	if (!resolved.startsWith(gitRoot + path.sep) && resolved !== gitRoot) {
		throw new Error(`Path escapes git root: ${filePath}`);
	}

	// Return forward-slash normalized relative path (git convention)
	return normalized.split(path.sep).join('/');
}

/**
 * ChangelistStore manages .git/cl.json — the mapping of changelist names
 * to arrays of relative file paths.
 *
 * Data format is compatible with the Python git-cl tool.
 */
export class ChangelistStore {
	private readonly filePath: string;
	private data: ChangelistData = {};

	constructor(private readonly gitRoot: string) {
		this.filePath = path.join(gitRoot, '.git', 'cl.json');
	}

	/** Load changelists from disk. Returns empty data if file doesn't exist. */
	load(): void {
		try {
			const raw = fs.readFileSync(this.filePath, 'utf-8');
			const parsed = JSON.parse(raw);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				this.data = {};
				return;
			}
			// Validate structure: every value must be string[]
			const result: ChangelistData = {};
			for (const [name, files] of Object.entries(parsed)) {
				if (Array.isArray(files) && files.every(f => typeof f === 'string')) {
					result[name] = files as string[];
				}
			}
			this.data = result;
		} catch {
			this.data = {};
		}
	}

	/** Save changelists to disk. Empty changelists are omitted. */
	save(): void {
		const toWrite: ChangelistData = {};
		for (const [name, files] of Object.entries(this.data)) {
			if (files.length > 0) {
				toWrite[name] = files;
			}
		}
		const dir = path.dirname(this.filePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(this.filePath, JSON.stringify(toWrite, null, 2) + '\n', 'utf-8');
	}

	/** Get all changelists (including empty ones in memory). */
	getAll(): Readonly<ChangelistData> {
		return this.data;
	}

	/** Get files in a specific changelist. Returns empty array if not found. */
	getFiles(name: string): readonly string[] {
		return this.data[name] ?? [];
	}

	/** Get all changelist names. */
	getNames(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Add files to a changelist. Creates the changelist if it doesn't exist.
	 * Files are automatically removed from any other changelist (single-ownership).
	 * Validates name and sanitizes paths.
	 *
	 * @param stashStore - optional StashStore to check for stash conflicts
	 */
	addFiles(name: string, files: string[], stashStore?: { getStashedFiles(): Set<string> }): void {
		const nameError = validateChangelistName(name);
		if (nameError) {
			throw new Error(nameError);
		}

		const sanitized = files.map(f => sanitizeFilePath(f, this.gitRoot));

		// Check stash conflicts
		if (stashStore) {
			const stashedFiles = stashStore.getStashedFiles();
			const conflicts = sanitized.filter(f => stashedFiles.has(f));
			if (conflicts.length > 0) {
				throw new Error(
					`Cannot add files that are in stashed changelists: ${conflicts.join(', ')}`
				);
			}
		}

		// Remove files from any existing changelist (single-ownership)
		const fileSet = new Set(sanitized);
		for (const [clName, clFiles] of Object.entries(this.data)) {
			this.data[clName] = clFiles.filter(f => !fileSet.has(f));
		}

		// Add to target changelist
		if (!this.data[name]) {
			this.data[name] = [];
		}
		const existing = new Set(this.data[name]);
		for (const f of sanitized) {
			if (!existing.has(f)) {
				this.data[name].push(f);
				existing.add(f);
			}
		}
	}

	/** Remove files from a specific changelist. */
	removeFiles(name: string, files: string[]): void {
		if (!this.data[name]) {
			return;
		}
		const toRemove = new Set(files.map(f => sanitizeFilePath(f, this.gitRoot)));
		this.data[name] = this.data[name].filter(f => !toRemove.has(f));
	}

	/** Create an empty changelist. */
	createChangelist(name: string): void {
		const nameError = validateChangelistName(name);
		if (nameError) {
			throw new Error(nameError);
		}
		if (!this.data[name]) {
			this.data[name] = [];
		}
	}

	/** Delete a changelist entirely. Returns the files that were in it. */
	deleteChangelist(name: string): string[] {
		const files = this.data[name] ?? [];
		delete this.data[name];
		return [...files];
	}

	/** Delete all changelists. */
	deleteAll(): void {
		this.data = {};
	}

	/** Find which changelist a file belongs to. Returns null if unassigned. */
	findChangelist(filePath: string): string | null {
		const sanitized = sanitizeFilePath(filePath, this.gitRoot);
		for (const [name, files] of Object.entries(this.data)) {
			if (files.includes(sanitized)) {
				return name;
			}
		}
		return null;
	}

	/** Get the path to cl.json */
	getFilePath(): string {
		return this.filePath;
	}
}
