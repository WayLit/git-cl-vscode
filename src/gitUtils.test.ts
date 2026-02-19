import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'child_process';
import {
	getGitRoot,
	getGitStatus,
	gitAdd,
	gitReset,
	gitCheckout,
	gitCommit,
	gitDiff,
	gitStashPush,
	gitStashDrop,
	gitStashPop,
	gitStashList,
	getCurrentBranch,
	gitCheckoutBranch,
	gitBranchExists,
	gitCheckoutExistingBranch,
} from './gitUtils';

// Mock child_process.execFile
vi.mock('child_process', () => ({
	execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(childProcess.execFile);

/** Helper to set up execFile mock to succeed with given stdout */
function mockExecSuccess(stdout: string) {
	mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
		(callback as Function)(null, stdout, '');
		return {} as any;
	});
}

/** Helper to set up execFile mock to fail with given error */
function mockExecError(message: string) {
	mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
		const error = new Error(message);
		(callback as Function)(error, '', message);
		return {} as any;
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ── getGitRoot ──────────────────────────────────────────────────────────────

describe('getGitRoot', () => {
	it('returns trimmed git root path', async () => {
		mockExecSuccess('/home/user/project\n');
		const root = await getGitRoot('/home/user/project/src');
		expect(root).toBe('/home/user/project');
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['rev-parse', '--show-toplevel'],
			expect.objectContaining({ cwd: '/home/user/project/src' }),
			expect.any(Function)
		);
	});

	it('rejects on git error', async () => {
		mockExecError('not a git repository');
		await expect(getGitRoot('/tmp')).rejects.toThrow('git rev-parse failed');
	});
});

// ── getGitStatus ────────────────────────────────────────────────────────────

describe('getGitStatus', () => {
	it('parses porcelain status output', async () => {
		mockExecSuccess(
			' M src/modified.ts\n' +
			'?? newfile.ts\n' +
			'A  src/added.ts\n' +
			'D  deleted.ts\n' +
			''
		);
		const status = await getGitStatus('/project');
		expect(status.get('src/modified.ts')).toBe(' M');
		expect(status.get('newfile.ts')).toBe('??');
		expect(status.get('src/added.ts')).toBe('A ');
		expect(status.get('deleted.ts')).toBe('D ');
	});

	it('handles renamed files (extracts new path)', async () => {
		mockExecSuccess('R  old.ts -> new.ts\n');
		const status = await getGitStatus('/project');
		expect(status.get('new.ts')).toBe('R ');
		expect(status.has('old.ts')).toBe(false);
	});

	it('returns empty map for clean repo', async () => {
		mockExecSuccess('');
		const status = await getGitStatus('/project');
		expect(status.size).toBe(0);
	});

	it('skips short/empty lines', async () => {
		mockExecSuccess(' M a.ts\n\n\n M b.ts\n');
		const status = await getGitStatus('/project');
		expect(status.size).toBe(2);
	});
});

// ── gitAdd ──────────────────────────────────────────────────────────────────

describe('gitAdd', () => {
	it('calls git add with file list', async () => {
		mockExecSuccess('');
		await gitAdd(['a.ts', 'b.ts'], '/project');
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['add', '--', 'a.ts', 'b.ts'],
			expect.objectContaining({ cwd: '/project' }),
			expect.any(Function)
		);
	});

	it('does nothing for empty file list', async () => {
		await gitAdd([], '/project');
		expect(mockedExecFile).not.toHaveBeenCalled();
	});
});

// ── gitReset ────────────────────────────────────────────────────────────────

describe('gitReset', () => {
	it('calls git reset HEAD with file list', async () => {
		mockExecSuccess('');
		await gitReset(['a.ts'], '/project');
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['reset', 'HEAD', '--', 'a.ts'],
			expect.objectContaining({ cwd: '/project' }),
			expect.any(Function)
		);
	});

	it('does nothing for empty file list', async () => {
		await gitReset([], '/project');
		expect(mockedExecFile).not.toHaveBeenCalled();
	});
});

// ── gitCheckout ─────────────────────────────────────────────────────────────

describe('gitCheckout', () => {
	it('calls git checkout HEAD with file list', async () => {
		mockExecSuccess('');
		await gitCheckout(['a.ts'], '/project');
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['checkout', 'HEAD', '--', 'a.ts'],
			expect.objectContaining({ cwd: '/project' }),
			expect.any(Function)
		);
	});

	it('does nothing for empty file list', async () => {
		await gitCheckout([], '/project');
		expect(mockedExecFile).not.toHaveBeenCalled();
	});
});

// ── gitCommit ───────────────────────────────────────────────────────────────

describe('gitCommit', () => {
	it('stages files and commits', async () => {
		mockExecSuccess('');
		await gitCommit(['a.ts'], 'fix bug', '/project');
		// First call: git add
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['add', '--', 'a.ts'],
			expect.objectContaining({ cwd: '/project' }),
			expect.any(Function)
		);
		// Second call: git commit
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['commit', '-m', 'fix bug'],
			expect.objectContaining({ cwd: '/project' }),
			expect.any(Function)
		);
	});

	it('rejects with empty files', async () => {
		await expect(gitCommit([], 'msg', '/project')).rejects.toThrow('No files');
	});

	it('rejects with empty message', async () => {
		await expect(gitCommit(['a.ts'], '', '/project')).rejects.toThrow('empty');
	});

	it('rejects with whitespace-only message', async () => {
		await expect(gitCommit(['a.ts'], '   ', '/project')).rejects.toThrow('empty');
	});
});

// ── gitDiff ─────────────────────────────────────────────────────────────────

describe('gitDiff', () => {
	it('calls git diff with files', async () => {
		mockExecSuccess('diff output');
		const result = await gitDiff(['a.ts'], '/project');
		expect(result).toBe('diff output');
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['diff', '--', 'a.ts'],
			expect.objectContaining({ cwd: '/project' }),
			expect.any(Function)
		);
	});

	it('passes --staged flag when requested', async () => {
		mockExecSuccess('');
		await gitDiff(['a.ts'], '/project', { staged: true });
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['diff', '--staged', '--', 'a.ts'],
			expect.objectContaining({ cwd: '/project' }),
			expect.any(Function)
		);
	});

	it('works with no files', async () => {
		mockExecSuccess('');
		await gitDiff([], '/project');
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['diff'],
			expect.objectContaining({ cwd: '/project' }),
			expect.any(Function)
		);
	});
});

// ── gitStashPush ────────────────────────────────────────────────────────────

describe('gitStashPush', () => {
	it('calls git stash push with message', async () => {
		mockExecSuccess('');
		await gitStashPush('my-stash', '/project');
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['stash', 'push', '-m', 'my-stash'],
			expect.objectContaining({ cwd: '/project' }),
			expect.any(Function)
		);
	});

	it('includes files when specified', async () => {
		mockExecSuccess('');
		await gitStashPush('msg', '/project', ['a.ts', 'b.ts']);
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['stash', 'push', '-m', 'msg', '--', 'a.ts', 'b.ts'],
			expect.objectContaining({ cwd: '/project' }),
			expect.any(Function)
		);
	});

	it('adds --include-untracked when requested', async () => {
		mockExecSuccess('');
		await gitStashPush('msg', '/project', ['a.ts'], { includeUntracked: true });
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['stash', 'push', '-m', 'msg', '--include-untracked', '--', 'a.ts'],
			expect.objectContaining({ cwd: '/project' }),
			expect.any(Function)
		);
	});
});

// ── gitStashDrop ────────────────────────────────────────────────────────────

describe('gitStashDrop', () => {
	it('calls git stash drop with ref', async () => {
		mockExecSuccess('');
		await gitStashDrop('stash@{0}', '/project');
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['stash', 'drop', 'stash@{0}'],
			expect.objectContaining({ cwd: '/project' }),
			expect.any(Function)
		);
	});
});

// ── gitStashPop ─────────────────────────────────────────────────────────────

describe('gitStashPop', () => {
	it('calls git stash pop with ref', async () => {
		mockExecSuccess('');
		await gitStashPop('stash@{1}', '/project');
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['stash', 'pop', 'stash@{1}'],
			expect.objectContaining({ cwd: '/project' }),
			expect.any(Function)
		);
	});
});

// ── gitStashList ────────────────────────────────────────────────────────────

describe('gitStashList', () => {
	it('parses stash list entries', async () => {
		mockExecSuccess(
			'stash@{0}: On main: git-cl-stash:feature:2026-01-01\n' +
			'stash@{1}: On main: some other stash\n'
		);
		const entries = await gitStashList('/project');
		expect(entries).toEqual([
			{ ref: 'stash@{0}', message: 'On main: git-cl-stash:feature:2026-01-01' },
			{ ref: 'stash@{1}', message: 'On main: some other stash' },
		]);
	});

	it('returns empty array for no stashes', async () => {
		mockExecSuccess('');
		const entries = await gitStashList('/project');
		expect(entries).toEqual([]);
	});

	it('returns empty array on error', async () => {
		mockExecError('fatal: no stash entries');
		const entries = await gitStashList('/project');
		expect(entries).toEqual([]);
	});
});

// ── getCurrentBranch ────────────────────────────────────────────────────────

describe('getCurrentBranch', () => {
	it('returns branch name', async () => {
		mockExecSuccess('main\n');
		const branch = await getCurrentBranch('/project');
		expect(branch).toBe('main');
	});

	it('returns null in detached HEAD state', async () => {
		mockExecError('fatal: ref HEAD is not a symbolic ref');
		const branch = await getCurrentBranch('/project');
		expect(branch).toBeNull();
	});

	it('returns null for empty output', async () => {
		mockExecSuccess('');
		const branch = await getCurrentBranch('/project');
		expect(branch).toBeNull();
	});
});

// ── gitCheckoutBranch ───────────────────────────────────────────────────────

describe('gitCheckoutBranch', () => {
	it('creates and switches to new branch', async () => {
		mockExecSuccess('');
		await gitCheckoutBranch('feature', '/project');
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['checkout', '-b', 'feature'],
			expect.objectContaining({ cwd: '/project' }),
			expect.any(Function)
		);
	});

	it('creates branch from specified base', async () => {
		mockExecSuccess('');
		await gitCheckoutBranch('feature', '/project', 'main');
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['checkout', '-b', 'feature', 'main'],
			expect.objectContaining({ cwd: '/project' }),
			expect.any(Function)
		);
	});
});

// ── gitBranchExists ─────────────────────────────────────────────────────────

describe('gitBranchExists', () => {
	it('returns true when branch exists', async () => {
		mockExecSuccess('abc123\n');
		const exists = await gitBranchExists('main', '/project');
		expect(exists).toBe(true);
	});

	it('returns false when branch does not exist', async () => {
		mockExecError('fatal: not a valid object name');
		const exists = await gitBranchExists('nonexistent', '/project');
		expect(exists).toBe(false);
	});
});

// ── gitCheckoutExistingBranch ───────────────────────────────────────────────

describe('gitCheckoutExistingBranch', () => {
	it('switches to existing branch', async () => {
		mockExecSuccess('');
		await gitCheckoutExistingBranch('main', '/project');
		expect(mockedExecFile).toHaveBeenCalledWith(
			'git',
			['checkout', 'main'],
			expect.objectContaining({ cwd: '/project' }),
			expect.any(Function)
		);
	});
});
