#!/usr/bin/env node
'use strict';

/**
 * reproject — move or rename a project folder without losing Claude Code history.
 *
 * Claude Code keys everything it remembers about a project to the project's
 * absolute path. Rename the folder and the CLI treats it as a brand new project:
 * empty /resume list, empty prompt history, lost per-project settings.
 *
 * This moves the folder and rewrites every path-keyed surface to match.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

function claudeLocations() {
  const home = os.homedir();
  const cfg = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(home, '.claude');
  const scoped = path.join(cfg, '.claude.json');
  const claudeJson = fs.existsSync(scoped) ? scoped : path.join(home, '.claude.json');
  return { cfg, claudeJson, projects: path.join(cfg, 'projects') };
}

/** Claude Code's project-dir name: every non-alphanumeric char becomes a dash. */
function mangle(absPath) {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Comparable form of a path: native separators, no trailing slash, case-folded on Windows. */
function norm(p) {
  let out = path.resolve(p).replace(/[\\/]+$/, '');
  return IS_WIN ? out.toLowerCase() : out;
}

// ---------------------------------------------------------------------------
// path spellings
//
// The same path shows up in these files at several escape levels: raw in
// filenames, backslash-escaped inside JSON, and double-escaped when a JSON
// document has been embedded in a JSON string. All of them have to move.
// ---------------------------------------------------------------------------

function spellings(p) {
  const win = p.replace(/\//g, '\\');
  const posix = p.replace(/\\/g, '/');
  const out = [
    win.replace(/\\/g, '\\\\\\\\'), // JSON inside JSON
    win.replace(/\\/g, '\\\\'), // JSON-escaped
    win, // raw
    posix, // forward-slash (how .claude.json keys projects)
  ];
  return out.filter((v, i) => out.indexOf(v) === i);
}

function buildRewriter(oldPath, newPath, { shallow = false } = {}) {
  const from = spellings(oldPath);
  const to = spellings(newPath);
  const pairs = from.map((f, i) => [f, to[i]]);

  // The project-dir name itself (e.g. G--code-gripe) appears in transcripts
  // whenever a session talked about its own history files.
  pairs.push([mangle(oldPath.replace(/\//g, '\\')), mangle(newPath.replace(/\//g, '\\'))]);

  pairs.sort((a, b) => b[0].length - a[0].length);

  const key = (s) => (IS_WIN ? s.toLowerCase() : s);
  const lookup = new Map(pairs.map(([f, t]) => [key(f), t]));
  const alternation = pairs.map(([f]) => escapeRe(f)).join('|');

  // Deep: every occurrence. Shallow: only the fields Claude Code reads back as
  // a location, leaving conversation text byte-identical.
  const KEYS = 'cwd|project|projectPath|projectDir|originalCwd|worktreePath|realParentDir|path';
  // The leading group is always present so the replace callback's second
  // argument is reliably the prefix and never the match offset.
  const pattern = shallow
    ? `("(?:${KEYS})"\\s*:\\s*"?)(?:${alternation})`
    : `()(?:${alternation})`;

  const flags = IS_WIN ? 'gi' : 'g';

  return function rewrite(text) {
    let count = 0;
    const out = text.replace(new RegExp(pattern, flags), (match, prefix) => {
      const body = match.slice(prefix.length);
      const replacement = lookup.get(key(body));
      if (replacement === undefined) return match;
      count++;
      return prefix + replacement;
    });
    return { text: out, count };
  };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

/** First `cwd` recorded in a project dir's transcripts, or null. */
function recordedCwd(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  for (const f of files) {
    let head;
    try {
      const fd = fs.openSync(path.join(dir, f), 'r');
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      head = buf.subarray(0, n).toString('utf8');
    } catch {
      continue;
    }
    const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) {
      try {
        return JSON.parse('"' + m[1] + '"');
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/**
 * Locate the history dir for a project path. Guesses the mangled name first,
 * then falls back to reading the recorded cwd out of every project dir — so
 * this keeps working even if Claude Code changes its naming scheme.
 */
function findProjectDir(projectsRoot, absPath) {
  const guess = path.join(projectsRoot, mangle(absPath));
  if (fs.existsSync(guess)) return guess;
  if (!fs.existsSync(projectsRoot)) return null;
  const target = norm(absPath);
  for (const name of fs.readdirSync(projectsRoot)) {
    const dir = path.join(projectsRoot, name);
    if (!safeIsDir(dir)) continue;
    const cwd = recordedCwd(dir);
    if (cwd && norm(cwd) === target) return dir;
  }
  return null;
}

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Running Claude Code sessions whose cwd is at or under `absPath`. */
function liveSessions(cfg, absPath) {
  const dir = path.join(cfg, 'sessions');
  if (!fs.existsSync(dir)) return [];
  const target = norm(absPath);
  const found = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!rec.cwd || !rec.pid) continue;
    const cwd = norm(rec.cwd);
    if (cwd !== target && !cwd.startsWith(target + path.sep)) continue;
    try {
      process.kill(rec.pid, 0); // signal 0 just probes for existence
      found.push(rec);
    } catch {
      /* stale record */
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// file sweep
// ---------------------------------------------------------------------------

const TEXT_EXT = new Set(['.json', '.jsonl', '.md', '.txt', '.yaml', '.yml']);

// Content snapshots and archives: these hold copies of the user's own files,
// not location keys. Rewriting them would corrupt real content.
const SKIP_DIRS = new Set([
  'projects', // handled explicitly
  'backups',
  'file-history',
  'shell-snapshots',
  'cache',
  'paste-cache',
  'downloads',
  'node_modules',
  '.git',
  'debug',
  'statsig',
]);

const MAX_FILE = 64 * 1024 * 1024;

function* walk(dir, { skipDirs = new Set(), depth = 0 } = {}) {
  if (depth > 12) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (skipDirs.has(e.name)) continue;
      yield* walk(full, { skipDirs, depth: depth + 1 });
    } else if (e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
      yield full;
    }
  }
}

function rewriteFile(file, rewrite, { dryRun, validateJson }) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return 0;
  }
  if (stat.size > MAX_FILE) return 0;

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }

  const { text: out, count } = rewrite(text);
  if (!count) return 0;

  if (validateJson) {
    try {
      JSON.parse(out);
    } catch (err) {
      throw new Error(`rewrite would corrupt ${file}: ${err.message}`);
    }
  }

  if (!dryRun) {
    const tmp = file + '.reproject.tmp';
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, file);
  }
  return count;
}

// ---------------------------------------------------------------------------
// moving
// ---------------------------------------------------------------------------

function movePath(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code === 'EXDEV') {
      fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
      fs.rmSync(from, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

/** Move a project history dir onto an existing one without clobbering sessions. */
function mergeProjectDir(from, to) {
  if (!fs.existsSync(to)) {
    movePath(from, to);
    return { merged: false, collisions: [] };
  }
  const collisions = [];
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    let dest = path.join(to, entry.name);
    if (fs.existsSync(dest)) {
      if (entry.isDirectory()) {
        fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
        fs.rmSync(src, { recursive: true, force: true });
        continue;
      }
      const ext = path.extname(entry.name);
      dest = path.join(to, path.basename(entry.name, ext) + '.merged' + ext);
      collisions.push(entry.name);
    }
    movePath(src, dest);
  }
  fs.rmSync(from, { recursive: true, force: true });
  return { merged: true, collisions };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    positional: [],
    dryRun: false,
    shallow: false,
    backup: true,
    move: true,
    force: false,
    quiet: false,
  };
  for (const arg of argv) {
    switch (arg) {
      case '-n':
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--shallow':
        opts.shallow = true;
        break;
      case '--no-backup':
        opts.backup = false;
        break;
      case '--no-move':
        opts.move = false;
        break;
      case '--force':
        opts.force = true;
        break;
      case '-q':
      case '--quiet':
        opts.quiet = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
        opts.positional.push(arg);
    }
  }
  return opts;
}

const USAGE = `reproject — rename/move a project folder, keep its Claude Code history

  reproject <old-path> <new-path> [options]

  <new-path> may be a full destination path or just a new folder name, in
  which case the folder stays in the same parent directory.

Options
  -n, --dry-run    report what would change, touch nothing
      --shallow    rewrite only location fields, leave conversation text alone
      --no-move    the folder was already moved; just fix Claude Code's state
      --no-backup  skip the safety copy under <claude-dir>/backups
      --force      proceed even if a Claude Code session is live in that folder
  -q, --quiet      only print the summary

Examples
  reproject G:\\code\\chrome-bug-recorder gripe
  reproject ~/dev/old-name ~/dev/archive/new-name --dry-run
`;

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err.message + '\n\n' + USAGE);
  }

  if (opts.help || opts.positional.length !== 2) {
    process.stdout.write(USAGE);
    process.exit(opts.help ? 0 : 1);
  }

  const oldPath = path.resolve(expandHome(opts.positional[0]));
  const rawNew = expandHome(opts.positional[1]);
  // A bare name means "same parent, new name".
  const newPath = /[\\/]/.test(rawNew) || path.isAbsolute(rawNew)
    ? path.resolve(rawNew)
    : path.join(path.dirname(oldPath), rawNew);

  const log = opts.quiet ? () => {} : (...a) => console.log(...a);
  const { cfg, claudeJson, projects } = claudeLocations();

  if (norm(oldPath) === norm(newPath)) fail('old and new paths are the same');
  if (opts.move && !fs.existsSync(oldPath)) {
    fail(`source folder does not exist: ${oldPath}\n(use --no-move if you already moved it)`);
  }
  if (opts.move && fs.existsSync(newPath)) fail(`destination already exists: ${newPath}`);
  if (!opts.move && !fs.existsSync(newPath)) fail(`--no-move given but destination does not exist: ${newPath}`);
  if (!fs.existsSync(cfg)) fail(`no Claude Code config dir at ${cfg}`);

  const inside = norm(process.cwd()) === norm(oldPath) || norm(process.cwd()).startsWith(norm(oldPath) + path.sep);
  if (inside && opts.move) {
    fail(`run this from outside ${oldPath} — a process cannot move its own working directory`);
  }

  const live = liveSessions(cfg, oldPath);
  if (live.length && !opts.force) {
    const list = live.map((s) => `  pid ${s.pid}  ${s.sessionId}`).join('\n');
    fail(
      `${live.length} Claude Code session(s) still running in that folder:\n${list}\n\n` +
        `Quit them first — a live session rewrites its transcript on exit and would\n` +
        `recreate the old project dir. Use --force to override.`
    );
  }

  const srcProjectDir = findProjectDir(projects, oldPath);
  const destProjectDir = path.join(projects, mangle(newPath));

  log(`  from  ${oldPath}`);
  log(`    to  ${newPath}`);
  if (srcProjectDir) {
    const sessions = fs.readdirSync(srcProjectDir).filter((f) => f.endsWith('.jsonl')).length;
    log(`\nhistory  ${srcProjectDir}`);
    log(`         ${sessions} session transcript(s) → ${path.basename(destProjectDir)}`);
  } else {
    log(`\nhistory  none found for this path (nothing to migrate)`);
  }
  if (opts.dryRun) log('\n[dry run] nothing will be written\n');

  // ----- backup ------------------------------------------------------------
  let backupDir = null;
  if (opts.backup && !opts.dryRun) {
    backupDir = path.join(cfg, 'backups', `reproject-${Date.now()}`);
    fs.mkdirSync(backupDir, { recursive: true });
    if (fs.existsSync(claudeJson)) fs.copyFileSync(claudeJson, path.join(backupDir, '.claude.json'));
    if (srcProjectDir) {
      fs.cpSync(srcProjectDir, path.join(backupDir, path.basename(srcProjectDir)), { recursive: true });
    }
    const histSrc = path.join(cfg, 'history.jsonl');
    if (fs.existsSync(histSrc)) fs.copyFileSync(histSrc, path.join(backupDir, 'history.jsonl'));
    log(`\nbackup   ${backupDir}`);
  }

  // ----- move the folder first, so a failure leaves nothing half-migrated ---
  if (opts.move && !opts.dryRun) {
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    try {
      movePath(oldPath, newPath);
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
        fail(
          `could not move the folder (${err.code}) — something is holding it open.\n` +
            `Usually a shell, editor, dev server, or Claude Code session sitting in it.\n` +
            `Nothing else was changed.`
        );
      }
      throw err;
    }
  }

  const rewrite = buildRewriter(oldPath, newPath, { shallow: opts.shallow });
  const changes = [];
  let total = 0;

  const apply = (file, { validateJson = false, label } = {}) => {
    const n = rewriteFile(file, rewrite, { dryRun: opts.dryRun, validateJson });
    if (n) {
      changes.push({ file: label || file, count: n });
      total += n;
    }
    return n;
  };

  // ----- project history dir -----------------------------------------------
  let movedProjectDir = null;
  if (srcProjectDir) {
    if (opts.dryRun) {
      movedProjectDir = srcProjectDir;
    } else {
      const { merged, collisions } = mergeProjectDir(srcProjectDir, destProjectDir);
      movedProjectDir = destProjectDir;
      if (merged) {
        log(`\n  merged into an existing history dir for ${newPath}`);
        for (const c of collisions) log(`    renamed on collision: ${c}`);
      }
    }
    for (const file of walk(movedProjectDir)) {
      apply(file, { label: path.join('projects', path.basename(movedProjectDir), path.relative(movedProjectDir, file)) });
    }
  }

  // ----- global state ------------------------------------------------------
  if (fs.existsSync(claudeJson)) apply(claudeJson, { validateJson: true, label: path.basename(claudeJson) });
  for (const file of walk(cfg, { skipDirs: SKIP_DIRS })) {
    apply(file, { label: path.relative(cfg, file) });
  }

  // ----- project-local config that carries absolute paths ------------------
  const localTargets = [path.join(newPath, '.claude'), path.join(newPath, '.mcp.json')];
  for (const target of localTargets) {
    if (!fs.existsSync(target)) continue;
    if (safeIsDir(target)) {
      for (const file of walk(target)) apply(file, { label: path.relative(newPath, file) });
    } else {
      apply(target, { label: path.relative(newPath, target) });
    }
  }

  // ----- report ------------------------------------------------------------
  if (!opts.quiet && changes.length) {
    log('\nrewrites');
    for (const c of changes.sort((a, b) => b.count - a.count).slice(0, 25)) {
      log(`  ${String(c.count).padStart(6)}  ${c.file}`);
    }
    if (changes.length > 25) log(`  ${String(changes.length - 25).padStart(6)}  more file(s)`);
  }

  const verb = opts.dryRun ? 'would rewrite' : 'rewrote';
  console.log(
    `\n${opts.dryRun ? '[dry run] ' : ''}${verb} ${total} path reference(s) across ${changes.length} file(s)`
  );
  if (!opts.dryRun) {
    console.log(`moved    ${oldPath}\n      -> ${newPath}`);
    if (backupDir) console.log(`backup   ${backupDir}`);
    console.log(`\nOpen the new folder and run /resume — your sessions should all be there.`);
  }
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function fail(msg) {
  console.error('reproject: ' + msg);
  process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    fail(err && err.stack ? err.stack : String(err));
  }
}

module.exports = { mangle, spellings, buildRewriter, findProjectDir, claudeLocations };
