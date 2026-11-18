import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChangelistTreeDataProvider } from './changelistTreeProvider';

const mocks = vi.hoisted(() => ({
	executeCommand: vi.fn(),
	getGitStatus: vi.fn(),
	watchers: [] as Array<{
		dir: string;
		file: string;
		change?: () => void;
		create?: () => void;
		delete?: () => void;
		dispose: () => void;
	}>,
}));

vi.mock('vscode', () => ({
	EventEmitter: class {
		event = vi.fn();
		fire = vi.fn();
	},
	Uri: { file: (fsPath: string) => ({ fsPath }) },
	RelativePattern: class {
		constructor(public baseUri: { fsPath: string }, public pattern: string) {}
	},
	workspace: {
		registerTextDocumentContentProvider: () => ({ dispose: vi.fn() }),
		onDidSaveTextDocument: () => ({ dispose: vi.fn() }),
		createFileSystemWatcher: (pattern: { baseUri: { fsPath: string }; pattern: string }) => {
			const watcher: typeof mocks.watchers[number] = {
				dir: pattern.baseUri.fsPath,
				file: pattern.pattern,
				dispose: vi.fn(),
			};
			mocks.watchers.push(watcher);
			return {
				onDidChange: (callback: () => void) => { watcher.change = callback; },
				onDidCreate: (callback: () => void) => { watcher.create = callback; },
				onDidDelete: (callback: () => void) => { watcher.delete = callback; },
				dispose: watcher.dispose,
			};
		},
	},
	window: { showWarningMessage: vi.fn() },
	commands: { executeCommand: mocks.executeCommand },
}));

vi.mock('./gitUtils', () => ({
	getGitStatus: mocks.getGitStatus,
}));

describe('ChangelistTreeDataProvider refresh', () => {
	let tmpDir: string;
	let commonDir: string;
	let worktreeDir: string;
	let provider: ChangelistTreeDataProvider;

	beforeEach(async () => {
		vi.useFakeTimers();
		mocks.watchers.length = 0;
		mocks.getGitStatus.mockReset().mockResolvedValue(new Map());
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-cl-tree-'));
		commonDir = path.join(tmpDir, 'common');
		worktreeDir = path.join(tmpDir, 'worktree-git');
		fs.mkdirSync(commonDir);
		fs.mkdirSync(worktreeDir);
		fs.writeFileSync(path.join(commonDir, 'cl.json'), JSON.stringify({ feature: ['file.txt'] }));
		fs.writeFileSync(path.join(tmpDir, 'file.txt'), '');
		provider = new ChangelistTreeDataProvider(tmpDir, undefined, commonDir, worktreeDir);
		await provider.refresh();
	});

	afterEach(() => {
		provider.dispose();
		vi.useRealTimers();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('watches shared data and the current worktree index and HEAD', () => {
		expect(mocks.watchers.map(({ dir, file }) => ({ dir, file }))).toEqual([
			{ dir: commonDir, file: 'cl.json' },
			{ dir: commonDir, file: 'cl-stashes.json' },
			{ dir: worktreeDir, file: 'index' },
			{ dir: worktreeDir, file: 'HEAD' },
		]);
	});

	it('reloads removed changelists on manual refresh', async () => {
		expect(provider.getChildren()).toContainEqual({ type: 'changelist', name: 'feature' });
		fs.writeFileSync(path.join(commonDir, 'cl.json'), '{}');
		await provider.refresh();
		expect(provider.getChildren()).toEqual([]);
	});

	it.each(['change', 'create', 'delete'] as const)('reloads after a cl.json %s event', async event => {
		fs.writeFileSync(path.join(commonDir, 'cl.json'), '{}');
		mocks.watchers[0][event]?.();
		await vi.advanceTimersByTimeAsync(300);
		expect(provider.getChildren()).toEqual([]);
	});

	it.each(['index', 'HEAD'])('refreshes on current worktree %s changes', async file => {
		fs.writeFileSync(path.join(commonDir, 'cl.json'), '{}');
		mocks.watchers.find(watcher => watcher.file === file)?.change?.();
		await vi.advanceTimersByTimeAsync(300);
		expect(provider.getChildren()).toEqual([]);
	});

	const staleContext = () => mocks.executeCommand.mock.calls.filter(c => c[1] === 'git-cl:hasStaleEntries').pop()?.[2];

	it('sets git-cl:hasStaleEntries when a changelist file is unchanged', async () => {
		expect(staleContext()).toBe(true);
		mocks.getGitStatus.mockResolvedValue(new Map([['file.txt', ' M']]));
		await provider.refresh();
		expect(staleContext()).toBe(false);
	});

	it('does not offer pruning when git status fails', async () => {
		mocks.getGitStatus.mockRejectedValue(new Error('boom'));
		await provider.refresh();
		expect(staleContext()).toBe(false);
	});
});
