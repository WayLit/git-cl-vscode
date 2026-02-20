import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StashStore, type StashMetadata } from './stashStore';

function makeMetadata(overrides: Partial<StashMetadata> = {}): StashMetadata {
	return {
		stash_ref: 'stash@{0}',
		stash_message: 'git-cl-stash:feature:2026-01-01T00:00:00Z',
		files: ['src/a.ts'],
		timestamp: '2026-01-01T00:00:00Z',
		source_branch: 'main',
		file_categories: {
			unstaged_changes: ['src/a.ts'],
			staged_additions: [],
			untracked: [],
			deleted: [],
		},
		...overrides,
	};
}

describe('StashStore', () => {
	let tmpDir: string;
	let gitDir: string;
	let store: StashStore;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-test-'));
		gitDir = path.join(tmpDir, '.git');
		fs.mkdirSync(gitDir);
		store = new StashStore(tmpDir);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe('load', () => {
		it('loads empty data when file does not exist', () => {
			store.load();
			expect(store.getAll()).toEqual({});
			expect(store.getNames()).toEqual([]);
		});

		it('loads valid cl-stashes.json', () => {
			const meta = makeMetadata();
			const data = { feature: meta };
			fs.writeFileSync(path.join(gitDir, 'cl-stashes.json'), JSON.stringify(data));
			store.load();
			expect(store.getAll()).toEqual(data);
			expect(store.getNames()).toEqual(['feature']);
		});

		it('handles malformed JSON gracefully', () => {
			fs.writeFileSync(path.join(gitDir, 'cl-stashes.json'), '{broken');
			store.load();
			expect(store.getAll()).toEqual({});
		});

		it('handles non-object JSON (array)', () => {
			fs.writeFileSync(path.join(gitDir, 'cl-stashes.json'), '[]');
			store.load();
			expect(store.getAll()).toEqual({});
		});

		it('handles null JSON', () => {
			fs.writeFileSync(path.join(gitDir, 'cl-stashes.json'), 'null');
			store.load();
			expect(store.getAll()).toEqual({});
		});

		it('filters out entries with invalid metadata structure', () => {
			const data = {
				valid: makeMetadata(),
				missing_ref: { stash_message: 'msg', files: [], timestamp: '', source_branch: '', file_categories: { unstaged_changes: [], staged_additions: [], untracked: [], deleted: [] } },
				not_object: 'string',
			};
			fs.writeFileSync(path.join(gitDir, 'cl-stashes.json'), JSON.stringify(data));
			store.load();
			expect(store.getNames()).toEqual(['valid']);
		});

		it('filters out entries with invalid file_categories', () => {
			const data = {
				bad_categories: {
					stash_ref: 'stash@{0}',
					stash_message: 'msg',
					files: [],
					timestamp: '',
					source_branch: '',
					file_categories: { unstaged_changes: 'not-array', staged_additions: [], untracked: [], deleted: [] },
				},
			};
			fs.writeFileSync(path.join(gitDir, 'cl-stashes.json'), JSON.stringify(data));
			store.load();
			expect(store.getNames()).toEqual([]);
		});
	});

	describe('save', () => {
		it('saves stash data to disk', () => {
			const meta = makeMetadata();
			store.setStash('feature', meta);
			store.save();
			const raw = fs.readFileSync(path.join(gitDir, 'cl-stashes.json'), 'utf-8');
			const parsed = JSON.parse(raw);
			expect(parsed).toEqual({ feature: meta });
		});

		it('saves empty object when no stashes', () => {
			store.save();
			const raw = fs.readFileSync(path.join(gitDir, 'cl-stashes.json'), 'utf-8');
			expect(JSON.parse(raw)).toEqual({});
		});

		it('creates parent directory if it does not exist', () => {
			fs.rmSync(gitDir, { recursive: true });
			store.setStash('test', makeMetadata());
			store.save();
			expect(fs.existsSync(path.join(gitDir, 'cl-stashes.json'))).toBe(true);
		});
	});

	describe('getStash', () => {
		it('returns metadata for existing stash', () => {
			const meta = makeMetadata();
			store.setStash('feature', meta);
			expect(store.getStash('feature')).toEqual(meta);
		});

		it('returns undefined for non-existent stash', () => {
			expect(store.getStash('nonexistent')).toBeUndefined();
		});
	});

	describe('setStash', () => {
		it('adds a new stash entry', () => {
			const meta = makeMetadata();
			store.setStash('feature', meta);
			expect(store.getNames()).toContain('feature');
		});

		it('overwrites existing stash entry', () => {
			store.setStash('feature', makeMetadata({ stash_ref: 'stash@{0}' }));
			store.setStash('feature', makeMetadata({ stash_ref: 'stash@{1}' }));
			expect(store.getStash('feature')?.stash_ref).toBe('stash@{1}');
		});
	});

	describe('removeStash', () => {
		it('removes a stash entry and returns its metadata', () => {
			const meta = makeMetadata();
			store.setStash('feature', meta);
			const removed = store.removeStash('feature');
			expect(removed).toEqual(meta);
			expect(store.getNames()).not.toContain('feature');
		});

		it('returns undefined for non-existent stash', () => {
			expect(store.removeStash('nonexistent')).toBeUndefined();
		});
	});

	describe('multiple stashes', () => {
		it('stores and retrieves multiple stashes independently', () => {
			const metaA = makeMetadata({ stash_ref: 'stash@{0}', files: ['a.ts'] });
			const metaB = makeMetadata({ stash_ref: 'stash@{1}', files: ['b.ts'] });
			const metaC = makeMetadata({ stash_ref: 'stash@{2}', files: ['c.ts'] });
			store.setStash('cl-a', metaA);
			store.setStash('cl-b', metaB);
			store.setStash('cl-c', metaC);
			expect(store.getNames()).toEqual(['cl-a', 'cl-b', 'cl-c']);
			expect(store.getStash('cl-b')?.stash_ref).toBe('stash@{1}');
		});

		it('selective removal leaves other stashes intact', () => {
			store.setStash('cl-a', makeMetadata({ files: ['a.ts'] }));
			store.setStash('cl-b', makeMetadata({ files: ['b.ts'] }));
			store.setStash('cl-c', makeMetadata({ files: ['c.ts'] }));
			store.removeStash('cl-b');
			expect(store.getNames()).toEqual(['cl-a', 'cl-c']);
			expect(store.getStash('cl-b')).toBeUndefined();
			expect(store.getStash('cl-a')?.files).toEqual(['a.ts']);
			expect(store.getStash('cl-c')?.files).toEqual(['c.ts']);
		});
	});

	describe('getStashedFiles', () => {
		it('returns set of all files across all stashes', () => {
			store.setStash('a', makeMetadata({ files: ['x.ts', 'y.ts'] }));
			store.setStash('b', makeMetadata({ files: ['y.ts', 'z.ts'] }));
			const files = store.getStashedFiles();
			expect(files).toEqual(new Set(['x.ts', 'y.ts', 'z.ts']));
		});

		it('returns empty set when no stashes', () => {
			expect(store.getStashedFiles()).toEqual(new Set());
		});

		it('updates after partial removal', () => {
			store.setStash('a', makeMetadata({ files: ['x.ts', 'y.ts'] }));
			store.setStash('b', makeMetadata({ files: ['y.ts', 'z.ts'] }));
			store.removeStash('a');
			const files = store.getStashedFiles();
			expect(files).toEqual(new Set(['y.ts', 'z.ts']));
		});
	});

	describe('getFilePath', () => {
		it('returns path to cl-stashes.json inside .git', () => {
			expect(store.getFilePath()).toBe(path.join(tmpDir, '.git', 'cl-stashes.json'));
		});
	});

	describe('metadata structure', () => {
		it('preserves snake_case keys for Python interop', () => {
			const meta = makeMetadata();
			store.setStash('test', meta);
			store.save();
			const raw = fs.readFileSync(path.join(gitDir, 'cl-stashes.json'), 'utf-8');
			const parsed = JSON.parse(raw);
			const entry = parsed.test;
			expect(entry).toHaveProperty('stash_ref');
			expect(entry).toHaveProperty('stash_message');
			expect(entry).toHaveProperty('source_branch');
			expect(entry).toHaveProperty('file_categories');
			expect(entry.file_categories).toHaveProperty('unstaged_changes');
			expect(entry.file_categories).toHaveProperty('staged_additions');
		});
	});

	describe('round-trip save/load', () => {
		it('preserves data through save and reload', () => {
			const meta = makeMetadata({ files: ['a.ts', 'b.ts'] });
			store.setStash('feature', meta);
			store.save();

			const store2 = new StashStore(tmpDir);
			store2.load();
			expect(store2.getStash('feature')).toEqual(meta);
		});
	});
});
