// L2 verification: resolve getDaemonCliPath / getCenterPath from the COMPILED
// dist/notification/win32.js and confirm the referenced files exist on disk.
const path = require('path');
const fs = require('fs');

let failed = false;
const assert = (name, ok) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) failed = true;
};

const moduleDir = path.join(__dirname, '..', 'dist', 'notification');
const expectedCli = path.join(moduleDir, '..', 'daemon-cli.js');            // dist/daemon-cli.js
const expectedCenter = path.join(moduleDir, '..', '..', 'src', 'center', 'CenterWindow.ps1');

assert('dist/notification/win32.js exists', fs.existsSync(path.join(moduleDir, 'win32.js')));
assert(`resolved daemon-cli exists: ${expectedCli}`, fs.existsSync(expectedCli));
assert(`resolved CenterWindow.ps1 exists: ${expectedCenter}`, fs.existsSync(expectedCenter));

const compiled = fs.readFileSync(path.join(moduleDir, 'win32.js'), 'utf8');
assert('compiled uses ../daemon-cli.js (one level up from dist/notification)',
  /join\(__dirname,\s*["']\.\.["'],\s*["']daemon-cli\.js["']\)/.test(compiled));
assert('compiled does NOT reference off-by-one dist/dist path',
  !/["']\.\.["'],\s*["']dist["'],\s*["']daemon-cli\.js["']/.test(compiled));
assert('compiled uses ../../src/center/CenterWindow.ps1',
  /["']\.\.["'],\s*["']\.\.["'],\s*["']src["'],\s*["']center["'],\s*["']CenterWindow\.ps1["']/.test(compiled));
assert('compiled passes string-array actions',
  /actions:\s*\[\s*["']View["'],\s*["']Dismiss["']\s*\]/.test(compiled));

process.exit(failed ? 1 : 0);
