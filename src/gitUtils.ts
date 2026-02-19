import { execFile } from 'child_process';
import * as path from 'path';

/** Result of parsing git status --porcelain output */
export type GitStatusMap = Map<string, string>;

/** A single stash entry from git stash list */
export interface StashEntry {
	ref: string;
	message: string;
}

/** Options for gitDiff */
export interface DiffOptions {
	staged?: boolean;
}

/**
 * Execute a git command using execFile (no shell) for safety.
 * All commands run with cwd set to the given directory.
 */
function execGit(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				const msg = stderr.trim() || stdout.trim() || error.message;
				reject(new Error(`git ${args[0]} failed: ${msg}`));
				return;
			}
			resolve(stdout);
		});
	});
}

/**
 * Returns the absolute path to the repository root.
 * Runs `git rev-parse --show-toplevel` from the given directory.
 */
export async function getGitRoot(cwd: string): Promise<string> {
	const output = await execGit(['rev-parse', '--show-toplevel'], cwd);
	return output.trim();
}

/**
 * Runs `git status --porcelain` and returns a parsed map of
 * relative file path → 2-character status code (e.g., " M", "??", "A ").
 */
export async function getGitStatus(gitRoot: string): Promise<GitStatusMap> {
	const output = await execGit(['status', '--porcelain'], gitRoot);
	const result: GitStatusMap = new Map();
	for (const line of output.split('\n')) {
		if (line.length < 4) {
			continue;
		}
		const status = line.substring(0, 2);
		let filePath = line.substring(3);
		// Handle renamed files: "R  old -> new"
		const arrowIndex = filePath.indexOf(' -> ');
		if (arrowIndex !== -1) {
			filePath = filePath.substring(arrowIndex + 4);
		}
		// Normalize path separators to forward slashes
		result.set(filePath.split(path.sep).join('/'), status);
	}
	return result;
}

/**
 * Stages the specified files via `git add`.
 * Paths are resolved relative to git root.
 */
export async function gitAdd(files: string[], gitRoot: string): Promise<void> {
	if (files.length === 0) {
		return;
	}
	await execGit(['add', '--', ...files], gitRoot);
}

/**
 * Unstages the specified files via `git reset HEAD`.
 */
export async function gitReset(files: string[], gitRoot: string): Promise<void> {
	if (files.length === 0) {
		return;
	}
	await execGit(['reset', 'HEAD', '--', ...files], gitRoot);
}

/**
 * Reverts files to HEAD via `git checkout HEAD --`.
 */
export async function gitCheckout(files: string[], gitRoot: string): Promise<void> {
	if (files.length === 0) {
		return;
	}
	await execGit(['checkout', 'HEAD', '--', ...files], gitRoot);
}

/**
 * Commits specified files with the given message.
 * Files are staged first via `git add`, then committed.
 */
export async function gitCommit(files: string[], message: string, gitRoot: string): Promise<void> {
	if (files.length === 0) {
		throw new Error('No files to commit');
	}
	if (!message || message.trim().length === 0) {
		throw new Error('Commit message cannot be empty');
	}
	// Stage the files first
	await gitAdd(files, gitRoot);
	// Commit only the staged files
	await execGit(['commit', '-m', message], gitRoot);
}

/**
 * Returns diff output for the specified files.
 * Supports --staged flag via options.
 */
export async function gitDiff(files: string[], gitRoot: string, options?: DiffOptions): Promise<string> {
	const args = ['diff'];
	if (options?.staged) {
		args.push('--staged');
	}
	if (files.length > 0) {
		args.push('--', ...files);
	}
	return execGit(args, gitRoot);
}

/**
 * Creates a stash with the given message.
 * If files are specified, only those files are stashed (using --).
 */
export async function gitStashPush(message: string, gitRoot: string, files?: string[]): Promise<void> {
	const args = ['stash', 'push', '-m', message];
	if (files && files.length > 0) {
		args.push('--', ...files);
	}
	await execGit(args, gitRoot);
}

/**
 * Pops a specific stash reference (e.g., "stash@{0}").
 */
export async function gitStashPop(ref: string, gitRoot: string): Promise<void> {
	await execGit(['stash', 'pop', ref], gitRoot);
}

/**
 * Lists stash entries with their references and messages.
 */
export async function gitStashList(gitRoot: string): Promise<StashEntry[]> {
	let output: string;
	try {
		output = await execGit(['stash', 'list'], gitRoot);
	} catch {
		return [];
	}
	const entries: StashEntry[] = [];
	for (const line of output.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		// Format: "stash@{0}: On branch: message"
		const colonIndex = line.indexOf(':');
		if (colonIndex === -1) {
			continue;
		}
		const ref = line.substring(0, colonIndex);
		const message = line.substring(colonIndex + 2);
		entries.push({ ref, message });
	}
	return entries;
}

/**
 * Returns the current branch name, or null if in detached HEAD state.
 */
export async function getCurrentBranch(gitRoot: string): Promise<string | null> {
	try {
		const output = await execGit(['symbolic-ref', '--short', 'HEAD'], gitRoot);
		return output.trim() || null;
	} catch {
		// Detached HEAD state
		return null;
	}
}

/**
 * Creates and switches to a new branch.
 * If base is provided, the branch is created from that base ref.
 */
export async function gitCheckoutBranch(name: string, gitRoot: string, base?: string): Promise<void> {
	const args = ['checkout', '-b', name];
	if (base) {
		args.push(base);
	}
	await execGit(args, gitRoot);
}
