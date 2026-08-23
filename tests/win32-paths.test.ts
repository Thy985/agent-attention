/**
 * Regression tests for src/notification/win32.ts path bugs.
 *
 * P1-3: centerPath must resolve to a real, reachable .ps1 file (was
 *   `dist/src/center/...` which doesn't exist after build).
 * P1-4: getDaemonCliPath must resolve to a real daemon-cli.js (was
 *   `dist/dist/daemon-cli.js` — off-by-one).
 * P1-1: actions array must be a string array, not an object array.
 * P1-2: response callback must handle 'view' / 'dismiss' / 'activate'.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Strip line/block comments from a TypeScript source file so tests can
 * match against actual code paths without being fooled by JSDoc comments
 * that mention the old broken paths.
 */
function stripComments(src: string): string {
  return src
    // Remove /* ... */ block comments (including JSDoc).
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Remove // line comments.
    .replace(/\/\/[^\n]*/g, '');
}

describe('win32.ts path resolution (P1-3 / P1-4 regression)', () => {
  let code: string;
  beforeAll(() => {
    const src = fs.readFileSync('src/notification/win32.ts', 'utf8');
    code = stripComments(src);
  });

  it('source no longer hard-codes dist/src/center/ for CenterWindow.ps1', () => {
    // Bug was `path.join(__dirname, '..', 'src', 'center', 'CenterWindow.ps1')`
    // which produces dist/src/center/... — the path never resolves.
    // The fixed form is `path.join(__dirname, '..', '..', 'src', ...)`.
    expect(code).not.toContain("path.join(__dirname, '..', 'src'");
  });

  it('getCenterPath uses ../../src/center/CenterWindow.ps1 (two .. segments)', () => {
    expect(code).toContain("path.join(__dirname, '..', '..', 'src', 'center', 'CenterWindow.ps1')");
  });

  it('source no longer hard-codes dist/dist/daemon-cli.js (off-by-one)', () => {
    // Bug was `path.join(__dirname, '..', 'dist', 'daemon-cli.js')` from
    // a file already in dist/, producing dist/dist/daemon-cli.js.
    expect(code).not.toMatch(/path\.join\([^)]*['"]\.\.['"]\s*,\s*['"]dist['"]\s*,\s*['"]daemon-cli\.js['"]/);
  });

  it('compiled output does not reference off-by-one paths', () => {
    const win32JsPath = path.join('dist', 'notification', 'win32.js');
    if (fs.existsSync(win32JsPath)) {
      // Check only executable join() calls — retained comments may quote
      // the historical bug verbatim.
      const joins = fs.readFileSync(win32JsPath, 'utf8')
        .match(/path\.join\([^;]*?\)/g) || [];
      const bad = joins.filter(j => /["']dist["']\s*,\s*["']daemon-cli\.js["']/.test(j));
      expect(bad).toEqual([]);
    }
  });

  it('getDaemonCliPath resolves one level up (dist/daemon-cli.js)', () => {
    // Compiled module lives at dist/notification/win32.js; daemon-cli.js is
    // at dist/daemon-cli.js — ONE level up, not a sibling, not ../dist/.
    expect(code).toMatch(/getDaemonCliPath/);
    expect(code).toMatch(/path\.join\(__dirname\s*,\s*['"]\.\.['"]\s*,\s*['"]daemon-cli\.js['"]\)/);
  });
});

describe('win32.ts Toast actions (P1-1 / P1-2 regression)', () => {
  let code: string;
  beforeAll(() => {
    const src = fs.readFileSync('src/notification/win32.ts', 'utf8');
    // stripComments is defined in the sibling describe block above.
    code = stripComments(src);
  });

  it('passes a string array for actions (not object array)', () => {
    // Must contain actions: ['View', 'Dismiss']  (string array)
    expect(code).toMatch(/actions:\s*\[\s*['"]View['"]\s*,\s*['"]Dismiss['"]\s*\]/);
    // Must NOT contain action: 'activate' style (object-array form)
    expect(code).not.toMatch(/action:\s*['"]activate['"]/);
    expect(code).not.toMatch(/content:\s*['"]View['"]/);
  });

  it('response handler matches view/dismiss/activate keys', () => {
    expect(code).toMatch(/['"]view['"]/);
    expect(code).toMatch(/['"]dismiss['"]/);
    expect(code).toMatch(/['"]activate['"]/);
  });

  it('uses toLowerCase before comparing activation keys', () => {
    // node-notifier lowercases activationType internally; we must too.
    expect(code).toMatch(/\.toLowerCase\(\)/);
  });
});
