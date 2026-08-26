/**
 * Regression tests for src/notification/win32.ts path bugs.
 *
 * P1-4: getDaemonCliPath must resolve to a real daemon-cli.js (off-by-one).
 * P1-1: actions array must be a string array, not an object array.
 * P1-2: response callback must handle 'view' / 'dismiss' / 'activate'.
 */

import * as fs from 'fs';
import * as path from 'path';

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('win32.ts path resolution (P1-4 regression)', () => {
  let code: string;
  beforeAll(() => {
    const src = fs.readFileSync('src/notification/win32.ts', 'utf8');
    code = stripComments(src);
  });

  it('source no longer references CenterWindow.ps1', () => {
    expect(code).not.toContain('CenterWindow.ps1');
    expect(code).not.toContain('getCenterPath');
  });

  it('source no longer hard-codes dist/dist/daemon-cli.js (off-by-one)', () => {
    expect(code).not.toMatch(/path\.join\([^)]*['"]\.\.['"]\s*,\s*['"]dist['"]\s*,\s*['"]daemon-cli\.js['"]/);
  });

  it('compiled output does not reference off-by-one paths', () => {
    const win32JsPath = path.join('dist', 'notification', 'win32.js');
    if (fs.existsSync(win32JsPath)) {
      const joins = fs.readFileSync(win32JsPath, 'utf8')
        .match(/path\.join\([^;]*?\)/g) || [];
      const bad = joins.filter(j => /["']dist["']\s*,\s*["']daemon-cli\.js["']/.test(j));
      expect(bad).toEqual([]);
    }
  });

  it('getDaemonCliPath resolves one level up (dist/daemon-cli.js)', () => {
    expect(code).toMatch(/getDaemonCliPath/);
    expect(code).toMatch(/path\.join\(__dirname\s*,\s*['"]\.\.['"]\s*,\s*['"]daemon-cli\.js['"]\)/);
  });

  it('Toast View uses resolveNativeUiPath and -OpenCenter', () => {
    expect(code).toContain('resolveNativeUiPath()');
    expect(code).toContain("'-OpenCenter'");
  });
});

describe('win32.ts Toast actions (P1-1 / P1-2 regression)', () => {
  let code: string;
  beforeAll(() => {
    const src = fs.readFileSync('src/notification/win32.ts', 'utf8');
    code = stripComments(src);
  });

  it('passes a string array for actions (not object array)', () => {
    expect(code).toMatch(/actions:\s*\[\s*['"]View['"]\s*,\s*['"]Dismiss['"]\s*\]/);
    expect(code).not.toMatch(/action:\s*['"]activate['"]/);
    expect(code).not.toMatch(/content:\s*['"]View['"]/);
  });

  it('response handler matches view/dismiss/activate keys', () => {
    expect(code).toMatch(/['"]view['"]/);
    expect(code).toMatch(/['"]dismiss['"]/);
    expect(code).toMatch(/['"]activate['"]/);
  });

  it('uses toLowerCase before comparing activation keys', () => {
    expect(code).toMatch(/\.toLowerCase\(\)/);
  });
});
