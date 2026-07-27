#!/usr/bin/env node
'use strict';

/**
 * Builds a throwaway Claude Code config dir, runs reproject against it, and
 * checks that every path-keyed surface came out the other side.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { mangle, buildRewriter } = require('./reproject.js');

const IS_WIN = process.platform === 'win32';
let passed = 0;

function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// --- unit: escape levels ----------------------------------------------------

check('rewrites raw, JSON-escaped and doubly-escaped spellings', () => {
  const rw = buildRewriter('G:\\code\\old', 'G:\\code\\new');
  const src = [
    '"cwd":"G:\\\\code\\\\old"',
    '"nested":"{\\\\"cwd\\\\":\\\\"G:\\\\\\\\code\\\\\\\\old\\\\"}"',
    'G:/code/old',
    'plain G:\\code\\old here',
  ].join('\n');
  const { text, count } = rw(src);
  assert.ok(count >= 4, `expected >= 4 rewrites, got ${count}`);
  assert.ok(!/old/.test(text.replace(/G:.code.new/g, '')), 'no stray old path left');
  assert.ok(text.includes('"cwd":"G:\\\\code\\\\new"'));
  assert.ok(text.includes('G:/code/new'));
});

check('rewrites the mangled project-dir name', () => {
  const rw = buildRewriter('G:\\code\\old', 'G:\\code\\new');
  const { text } = rw('~/.claude/projects/G--code-old/abc.jsonl');
  assert.ok(text.includes('G--code-new'), text);
});

check('leaves the bare folder name in prose alone', () => {
  const rw = buildRewriter('G:\\code\\old-thing', 'G:\\code\\new-thing');
  const { text } = rw('the user said rename old-thing please');
  assert.strictEqual(text, 'the user said rename old-thing please');
});

check('shallow mode touches only location fields', () => {
  const rw = buildRewriter('G:\\code\\old', 'G:\\code\\new', { shallow: true });
  const { text } = rw('{"cwd":"G:\\\\code\\\\old","text":"I edited G:\\\\code\\\\old\\\\a.ts"}');
  assert.ok(text.includes('"cwd":"G:\\\\code\\\\new"'));
  assert.ok(text.includes('I edited G:\\\\code\\\\old\\\\a.ts'), 'prose untouched');
});

check('mangle matches Claude Code naming', () => {
  assert.strictEqual(mangle('G:\\code\\shitpost.gg'), 'G--code-shitpost-gg');
  assert.strictEqual(mangle('/Users/x/dev/app'), '-Users-x-dev-app');
});

// --- integration: a fake config dir ----------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reproject-test-'));
const cfg = path.join(root, '.claude');
const oldDir = path.join(root, 'work', 'old-name');
const newDir = path.join(root, 'work', 'gripe');

fs.mkdirSync(path.join(oldDir, '.claude'), { recursive: true });
fs.writeFileSync(path.join(oldDir, 'index.js'), '// hello\n');
fs.writeFileSync(
  path.join(oldDir, '.claude', 'settings.local.json'),
  JSON.stringify({ permissions: { allow: [`Read(${oldDir})`] } }, null, 2)
);

const proj = path.join(cfg, 'projects', mangle(oldDir));
fs.mkdirSync(path.join(proj, 'memory'), { recursive: true });
fs.writeFileSync(
  path.join(proj, 'sess-1.jsonl'),
  [
    JSON.stringify({ type: 'user', cwd: oldDir, message: { role: 'user', content: 'hi' } }),
    JSON.stringify({
      type: 'file-history-snapshot',
      snapshot: { trackedFileBackups: { 'index.js': { realParentDir: oldDir } } },
    }),
  ].join('\n') + '\n'
);
fs.writeFileSync(path.join(proj, 'memory', 'MEMORY.md'), `see ${oldDir}\\index.js\n`);

fs.writeFileSync(
  path.join(root, '.claude.json'),
  JSON.stringify(
    {
      projects: { [oldDir.replace(/\\/g, '/')]: { allowedTools: [], hasTrustDialogAccepted: true } },
      githubRepoPaths: { 'dested/thing': [oldDir] },
    },
    null,
    2
  )
);
fs.writeFileSync(
  path.join(cfg, 'history.jsonl'),
  JSON.stringify({ display: '/model', project: oldDir }) + '\n'
);
fs.mkdirSync(path.join(cfg, 'sessions'), { recursive: true });
fs.writeFileSync(
  path.join(cfg, 'sessions', '999999.json'),
  JSON.stringify({ pid: 999999, sessionId: 'abc', cwd: oldDir })
);
// A content snapshot that must NOT be rewritten.
fs.mkdirSync(path.join(cfg, 'file-history', 'abc'), { recursive: true });
fs.writeFileSync(path.join(cfg, 'file-history', 'abc', 'deadbeef@v1'), `const p = "${oldDir}"\n`);

// The tool reads .claude.json from CLAUDE_CONFIG_DIR when it lives there.
fs.copyFileSync(path.join(root, '.claude.json'), path.join(cfg, '.claude.json'));

const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };

const dry = execFileSync(process.execPath, [path.join(__dirname, 'reproject.js'), oldDir, newDir, '--dry-run'], {
  env,
  cwd: root,
  encoding: 'utf8',
});
check('dry run changes nothing on disk', () => {
  assert.ok(fs.existsSync(oldDir), 'source folder still there');
  assert.ok(fs.existsSync(proj), 'history dir still there');
  assert.ok(/dry run/.test(dry), dry);
});

const out = execFileSync(process.execPath, [path.join(__dirname, 'reproject.js'), oldDir, newDir], {
  env,
  cwd: root,
  encoding: 'utf8',
});

check('folder moved', () => {
  assert.ok(!fs.existsSync(oldDir));
  assert.ok(fs.existsSync(path.join(newDir, 'index.js')));
});

check('history dir renamed to the new mangled name', () => {
  const dest = path.join(cfg, 'projects', mangle(newDir));
  assert.ok(fs.existsSync(dest), `${dest} missing`);
  assert.ok(!fs.existsSync(proj));
});

check('transcript cwd and realParentDir follow the move', () => {
  const dest = path.join(cfg, 'projects', mangle(newDir), 'sess-1.jsonl');
  const lines = fs.readFileSync(dest, 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(lines[0].cwd, newDir);
  assert.strictEqual(lines[1].snapshot.trackedFileBackups['index.js'].realParentDir, newDir);
});

check('memory files come along', () => {
  const mem = fs.readFileSync(path.join(cfg, 'projects', mangle(newDir), 'memory', 'MEMORY.md'), 'utf8');
  assert.ok(mem.includes(newDir), mem);
});

check('.claude.json project key re-keyed', () => {
  const j = JSON.parse(fs.readFileSync(path.join(cfg, '.claude.json'), 'utf8'));
  const keys = Object.keys(j.projects);
  assert.deepStrictEqual(keys, [newDir.replace(/\\/g, '/')], keys.join(','));
  assert.strictEqual(j.projects[keys[0]].hasTrustDialogAccepted, true);
  assert.deepStrictEqual(j.githubRepoPaths['dested/thing'], [newDir]);
});

check('prompt history re-pointed', () => {
  const h = JSON.parse(fs.readFileSync(path.join(cfg, 'history.jsonl'), 'utf8').trim());
  assert.strictEqual(h.project, newDir);
});

check('session registry updated', () => {
  const s = JSON.parse(fs.readFileSync(path.join(cfg, 'sessions', '999999.json'), 'utf8'));
  assert.strictEqual(s.cwd, newDir);
});

check('project-local settings updated', () => {
  const s = JSON.parse(fs.readFileSync(path.join(newDir, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepStrictEqual(s.permissions.allow, [`Read(${newDir})`]);
});

check('file content snapshots left untouched', () => {
  const snap = fs.readFileSync(path.join(cfg, 'file-history', 'abc', 'deadbeef@v1'), 'utf8');
  assert.ok(snap.includes(oldDir), 'snapshot content must not be rewritten');
});

check('a backup was written', () => {
  const backups = fs.readdirSync(path.join(cfg, 'backups'));
  assert.ok(backups.some((b) => b.startsWith('reproject-')), backups.join(','));
  assert.ok(/backup/.test(out), out);
});

check('refuses when source is missing', () => {
  assert.throws(() =>
    execFileSync(process.execPath, [path.join(__dirname, 'reproject.js'), oldDir, newDir], {
      env,
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    })
  );
});

check('refuses a live session without --force', () => {
  const liveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reproject-live-'));
  const liveCfg = path.join(liveRoot, '.claude');
  const src = path.join(liveRoot, 'proj');
  fs.mkdirSync(path.join(liveCfg, 'sessions'), { recursive: true });
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(liveCfg, '.claude.json'), '{}');
  fs.writeFileSync(
    path.join(liveCfg, 'sessions', 'me.json'),
    JSON.stringify({ pid: process.pid, sessionId: 'live', cwd: src })
  );
  let stderr = '';
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'reproject.js'), src, path.join(liveRoot, 'p2')], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: liveCfg },
      cwd: liveRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.fail('should have refused');
  } catch (err) {
    stderr = err.stderr || '';
  }
  assert.ok(/still running/.test(stderr), stderr);
  fs.rmSync(liveRoot, { recursive: true, force: true });
});

check('bare new name keeps the parent directory', () => {
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'reproject-bare-'));
  const c2 = path.join(r2, '.claude');
  fs.mkdirSync(c2, { recursive: true });
  fs.writeFileSync(path.join(c2, '.claude.json'), '{}');
  const a = path.join(r2, 'aaa');
  fs.mkdirSync(a);
  execFileSync(process.execPath, [path.join(__dirname, 'reproject.js'), a, 'bbb', '-q'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: c2 },
    cwd: r2,
    encoding: 'utf8',
  });
  assert.ok(fs.existsSync(path.join(r2, 'bbb')), 'renamed in place');
  fs.rmSync(r2, { recursive: true, force: true });
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} passed${IS_WIN ? ' (win32)' : ''}`);
