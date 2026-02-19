# git-cl for VS Code

Manage [git-cl](https://github.com/BHFock/git-cl) changelists directly in VS Code. Organize your working changes into logical groups for focused commits — no Python dependency required.

## Features

- **Changelists in Source Control** — Each changelist appears as a group in the Source Control sidebar with file status decorations (modified, added, deleted, untracked).
- **Add files from anywhere** — Right-click files in the built-in Git Changes section or the Unassigned group to assign them to a changelist.
- **Stage, commit, diff, revert per changelist** — Inline buttons on each changelist header let you stage, commit, diff, or revert all files in the group with one click.
- **Stash & unstash changelists** — Temporarily shelve a changelist (or all of them) and restore later. Stash metadata tracks source branch and timestamps.
- **Branch from changelist** — Create a new branch containing only the files in a specific changelist.
- **Auto-refresh** — The tree updates automatically when `cl.json` changes on disk (e.g. from the CLI tool) or when git status changes.
- **Fully interoperable** — Reads and writes the same `.git/cl.json` and `.git/cl-stashes.json` files as the Python CLI, so you can use both tools side by side.

## Installation

### From VSIX (local build)

```sh
npm install
npm run package
code --install-extension git-cl-vscode-0.0.1.vsix
```

### Development

```sh
npm install
# Press F5 in VS Code to launch the Extension Development Host
```

## Usage

Open a workspace that contains a `.git` directory. The extension activates automatically and adds a **Changelists** section to the Source Control sidebar.

### Adding files to a changelist

- Right-click a file in the built-in **Changes** list and select **Add to Changelist**.
- Or right-click a file in the **Unassigned** group under Changelists.
- Or run `git-cl: Add to Changelist` from the Command Palette.

You'll be prompted to pick an existing changelist or create a new one. Files can only belong to one changelist at a time — adding a file to a new changelist silently moves it.

### Changelist operations

Each changelist group header has inline action buttons:

| Button | Action |
|--------|--------|
| **+** | Stage all tracked files in the changelist |
| **-** | Unstage all staged files in the changelist |
| **checkmark** | Commit the changelist (prompts for message) |
| **trash** | Delete the changelist (files return to Unassigned) |

Additional operations are available via right-click on the changelist header or the Command Palette:

- **Diff Changelist** — Open diff tabs for every file in the changelist.
- **Checkout (Revert) Changelist** — Discard all changes, reverting files to HEAD.
- **Stash Changelist** — Stash the changelist's changes and save metadata.
- **Branch from Changelist** — Create a new branch with only this changelist's files.

### Stashed changelists

Stashed changelists appear in a read-only **Stashed** section with their source branch and timestamp. Right-click to **Unstash** and restore the changelist.

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) under the `git-cl` category:

| Command | Description |
|---------|-------------|
| `git-cl: Add to Changelist` | Add files to a changelist |
| `git-cl: Remove from Changelist` | Remove files from their changelist |
| `git-cl: Delete Changelist` | Delete a changelist |
| `git-cl: Delete All Changelists` | Delete all changelists |
| `git-cl: Stage Changelist` | Stage tracked files in a changelist |
| `git-cl: Unstage Changelist` | Unstage files in a changelist |
| `git-cl: Commit Changelist` | Commit a changelist with a message |
| `git-cl: Diff Changelist` | Open diffs for all files in a changelist |
| `git-cl: Checkout (Revert) Changelist` | Revert files to HEAD |
| `git-cl: Show Changelist Status` | Show formatted status in the output panel |
| `git-cl: Stash Changelist` | Stash a single changelist |
| `git-cl: Stash All Changelists` | Stash all active changelists |
| `git-cl: Unstash Changelist` | Restore a stashed changelist |
| `git-cl: Unstash Changelist (Force)` | Unstash without branch/conflict checks |
| `git-cl: Unstash All Changelists` | Restore all stashed changelists |
| `git-cl: Branch from Changelist` | Create a new branch from a changelist |

## Requirements

- VS Code 1.85+
- Git installed and available on `PATH`

## License

MIT
