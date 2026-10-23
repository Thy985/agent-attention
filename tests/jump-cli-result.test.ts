import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// Real subprocess verifies exit status and machine-readable CLI output.
// Run `npm run build` before this suite, as for the repository's other dist tests.
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-jump-cli-'));
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ version: 3, agents: [
    { agent_id: 'no-target', name: 'Test', registered_at: Date.now(), last_seen_at: Date.now(), target: null },
    { agent_id: 'invalid', name: 'Test', registered_at: Date.now(), last_seen_at: Date.now(), target: { type: 'terminal', pid: 0 } },
  ] }));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
it.each([['missing','agent-not-found'], ['no-target','no-target'], ['invalid','invalid-pid']])(
  'returns exit 1 and JSON reason for %s', (id, reason) => {
    const run = spawnSync(process.execPath, [path.resolve('dist/daemon-cli.js'), 'jump', id, '--json'], {
      env: { ...process.env, AGENT_ATTENTION_HOME: home }, encoding: 'utf8', timeout: 15000,
    });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: false, reason });
    expect(run.stdout).not.toContain('Jumped to');
  },
);
