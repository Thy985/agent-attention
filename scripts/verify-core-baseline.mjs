#!/usr/bin/env node
/** Environment-scoped core gate. Requires dependencies plus .NET 10 on PATH.
 * No desktop/UI/service/installed-exe tests are represented as exercised here.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-core-gate-'));
const env = { ...process.env, AGENT_ATTENTION_HOME: home };
function run(label, command, args) {
  console.log(`\n== ${label} ==`);
  const p = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (p.error) { console.error(p.error.message); process.exitCode = 1; return false; }
  if (p.status !== 0) { console.error(`${label} failed (exit ${p.status}, signal ${p.signal ?? 'none'})`); process.exitCode = 1; return false; }
  return true;
}
try {
  if (run('TypeScript build', process.execPath, ['node_modules/typescript/bin/tsc']) &&
      run('Core/contract regression gate (Linux tests launch isolated daemon subprocesses)', process.execPath, [
        'node_modules/jest/bin/jest.js', '--runInBand', '--forceExit', '--runTestsByPath',
        'tests/ipc-stream-regression.test.ts', 'tests/jump-result.test.ts', 'tests/jump-command-result.test.ts',
        'tests/jump-cli-result.test.ts', 'tests/event-contract.test.ts', 'tests/integration.test.ts',
        'tests/hooks.test.ts', 'tests/state.test.ts', 'tests/dedup.test.ts', 'tests/platform-headless.test.ts',
      ])) {
    run('Production-linked C# loopback IPC harness (.NET 10 required)', 'dotnet', [
      'run', '--project', 'tests/ipc-client-harness/IpcClientHarness.csproj', '-c', 'Release',
    ]) && run('Production-linked UI command/evidence contract harness (no WPF rendering)', 'dotnet', [
      'run', '--project', 'tests/ui-contract-harness/UiContractHarness.csproj', '-c', 'Release',
    ]);
  }
} finally { fs.rmSync(home, { recursive: true, force: true }); }
if (!process.exitCode) console.log('\nCore gate passed. Windows desktop and live provider acceptance remain separate.');
