---
name: reproject
description: Rename or move a project folder without losing its Claude Code history (sessions, /resume list, prompt history, per-project settings, memory). Use when the user wants to rename the current project or repo folder, move a project to a new directory, or has already moved one and lost their session history.
---

# reproject

Claude Code keys every project memory to the project's absolute path. Renaming
the folder orphans all of it — the `/resume` list, prompt history, per-project
settings and trust, and `memory/`. `reproject` moves the folder and re-points
every path-keyed surface at the new location.

## Run it

```bash
node ~/.claude/skills/reproject/reproject.js <old-path> <new-path>
```

`<new-path>` may be a bare folder name, which keeps it in the same parent.

Always show the user a `--dry-run` first unless they've already approved the
exact move:

```bash
node ~/.claude/skills/reproject/reproject.js "G:\code\old-name" gripe --dry-run
```

Flags: `--dry-run`, `--shallow` (only location fields, leaves conversation text
alone), `--no-move` (folder already moved), `--no-backup`, `--force`, `--quiet`.

## The one thing that will trip you up

**A Claude Code session running inside the folder blocks this**, including the
session you are running in right now.

- On Windows the OS refuses to move a directory that is a live process's cwd.
- On any platform, a live session flushes its transcript on exit — writing it
  back under the *old* path and recreating the orphan.

The tool detects live sessions and refuses. So if the user asks you to rename
the folder you are currently working in, you cannot finish it yourself. Do this
instead:

1. Run `--dry-run` and show them exactly what will move.
2. Do everything that *doesn't* require the move — git remote rename, `name` in
   `package.json`, README/docs references, and so on. Commit that.
3. Give them the single command to paste after they quit, and say plainly that
   they have to quit first:

```
cd / && node ~/.claude/skills/reproject/reproject.js "<old>" "<new>"
```

4. Tell them to reopen Claude Code in the new folder and run `/resume` — the
   whole session list, including the one where they asked for the rename, will
   be there.

Do not try to work around the lock by copying the folder, and do not pass
`--force` to move out from under a live session.

## Verifying afterwards

```bash
ls ~/.claude/projects/ | grep <new-name>          # history dir renamed
node -e "console.log(Object.keys(require(require('os').homedir()+'/.claude.json').projects).filter(p=>/<new-name>/.test(p)))"
```

A backup lands in `~/.claude/backups/reproject-<timestamp>/` (`.claude.json`,
`history.jsonl`, and the full history dir) unless `--no-backup` was passed.

## What it does not touch

`~/.claude/file-history/` and `~/.claude/backups/` hold copies of the user's
actual source files. The old path appears in them as file *content*, not as a
key, so rewriting it there would corrupt real content. Leave that alone.
