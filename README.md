# reproject

Rename or move a project folder without losing its Claude Code history.

Claude Code keys everything it remembers about a project to that project's
absolute path. Rename `G:\code\chrome-bug-recorder` to `G:\code\gripe` and the
CLI treats it as a project it has never seen: empty `/resume` list, empty prompt
history, per-project settings and trust gone, memory gone.

Nothing was actually deleted — it's all still sitting under the old path's key.
`reproject` moves the folder and re-points every one of those keys at the new
location.

```
npx github:dested/reproject G:\code\chrome-bug-recorder gripe
```

## What it fixes

| Surface | What lives there |
|---|---|
| `~/.claude/projects/<mangled-cwd>/` | every session transcript, plus `memory/` |
| `cwd` inside those `.jsonl` files | which folder each session thinks it's in |
| `realParentDir` in checkpoint snapshots | file rewind / undo targets |
| `~/.claude.json` → `projects["<path>"]` | trust, allowed tools, MCP servers, onboarding |
| `~/.claude.json` → `githubRepoPaths` | repo↔folder mapping |
| `~/.claude/history.jsonl` | the ↑-arrow prompt history, keyed by project |
| `~/.claude/sessions/*.json`, `teams/*/config.json` | the live-session registry |
| `<project>/.claude/**`, `<project>/.mcp.json` | absolute paths in local config |

The path is matched at every escape level it appears in — raw, JSON-escaped
(`G:\\code\\x`), doubly-escaped (`G:\\\\code\\\\x`), forward-slash, and the
mangled directory name (`G--code-x`) — so nothing is left half-renamed.

It deliberately does **not** rewrite `~/.claude/file-history/` or `backups/`.
Those hold copies of your actual source files; the path only appears in them as
file content.

## Usage

```
reproject <old-path> <new-path> [options]
```

`<new-path>` can be a full destination or just a new folder name, in which case
the folder stays where it is and only the name changes.

| Option | |
|---|---|
| `-n`, `--dry-run` | report what would change, write nothing |
| `--shallow` | rewrite only location fields, leave conversation text byte-identical |
| `--no-move` | you already moved the folder; just fix Claude Code's state |
| `--no-backup` | skip the safety copy under `~/.claude/backups/` |
| `--force` | proceed even with a Claude Code session live in that folder |
| `-q`, `--quiet` | summary only |

```bash
# see what would happen
reproject G:\code\chrome-bug-recorder gripe --dry-run

# rename in place
reproject G:\code\chrome-bug-recorder gripe

# move somewhere else entirely
reproject ~/dev/scratch-thing ~/dev/archive/2026/scratch-thing

# you already did `mv` yourself and just want the history to catch up
reproject ~/dev/old-name ~/dev/new-name --no-move
```

## Before you run it

**Quit any Claude Code session running in that folder.** A live session holds
the directory open (on Windows the move fails outright), and on exit it flushes
its transcript back to the *old* project key — recreating exactly the orphan you
were trying to avoid. `reproject` checks for live sessions and refuses unless
you pass `--force`.

The folder is moved first, before any state is rewritten. If the move fails,
nothing else has been touched.

Unless you pass `--no-backup`, a copy of `.claude.json`, `history.jsonl` and the
project's whole history dir is written to
`~/.claude/backups/reproject-<timestamp>/` first.

## Deep vs shallow

By default every occurrence of the old path is rewritten, including inside the
text of past conversations. That's usually what you want: file links in the
transcript keep resolving, and rewind still finds its targets.

`--shallow` restricts rewrites to fields Claude Code reads back as a location
(`cwd`, `project`, `realParentDir`, …) and leaves the conversation text exactly
as it was recorded.

## As a Claude Code skill

```bash
node install.js
```

Copies the skill to `~/.claude/skills/reproject/` so you can just say
"rename this project to gripe" in Claude Code and it'll do the whole thing,
including checking for live sessions.

## As a PowerShell function

A wrapper worth having, because the common case is "rename the project I'm
standing in" — which is also the case the CLI can't do on its own, since a
process can't move its own working directory:

```powershell
function renamer {
    param([Parameter(Position=0)][string]$Name, [switch]$DryRun)
    $from = & git rev-parse --show-toplevel 2>$null
    $from = if ($LASTEXITCODE -eq 0 -and $from) { $from.Replace('/','\') } else { (Get-Location).Path }
    $dest = Join-Path (Split-Path $from -Parent) $Name
    if (-not $DryRun) { Set-Location (Split-Path $from -Parent) }
    node "$HOME\.claude\skills\reproject\reproject.js" $from $dest @(if ($DryRun) {'--dry-run'})
    if (-not $DryRun) { Set-Location (Test-Path $dest ? $dest : $from) }
}
```

`renamer gripe` then renames the whole repo, from anywhere inside it, and
leaves you in the renamed folder.

## Install

```bash
# one-off
npx github:dested/reproject <old> <new>

# or globally
npm i -g github:dested/reproject
```

Zero dependencies. Node 18+.

## Tests

```bash
npm test
```

Builds a throwaway `CLAUDE_CONFIG_DIR`, runs the real CLI against it, and
asserts each surface came out the other side.

## Notes

- Respects `CLAUDE_CONFIG_DIR`.
- Windows, macOS and Linux. Path comparison is case-insensitive on Windows.
- If the destination already has a history dir (you've used that path before),
  the two are merged; transcripts are keyed by session UUID so they won't
  collide, and anything that does collide is kept as `<name>.merged<ext>`.
- Finds the history dir by name first, then by reading the recorded `cwd` out of
  each project dir — so it still works if Claude Code changes its naming scheme.

## License

MIT
