#!/usr/bin/env node
'use strict';

/** Installs the reproject skill (and the CLI it shells out to) into ~/.claude/skills. */

const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
  : path.join(os.homedir(), '.claude');

const dest = path.join(cfg, 'skills', 'reproject');
fs.mkdirSync(dest, { recursive: true });

fs.copyFileSync(path.join(__dirname, 'skills', 'reproject', 'SKILL.md'), path.join(dest, 'SKILL.md'));
fs.copyFileSync(path.join(__dirname, 'reproject.js'), path.join(dest, 'reproject.js'));

console.log(`installed -> ${dest}`);
console.log(`\nTry it:  node ${path.join(dest, 'reproject.js')} --help`);
console.log(`Or in Claude Code, just say: "rename this project to <name>"`);
