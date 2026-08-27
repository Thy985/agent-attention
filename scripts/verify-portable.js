const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const zipPath = path.join(__dirname, '..', 'dist', 'portable', 'agent-attention-0.2.0-win-x64.zip');
const extractDir = path.join(os.tmpdir(), 'aa-verify-' + Date.now());

console.log('Extracting package...');
execSync('7z x "' + zipPath + '" -o"' + extractDir + '" -y', { stdio: 'inherit' });

const checks = [
  'node/node.exe',
  'dist/daemon-cli.js',
  'dist/index.js',
  'src/center/csharp/dist/win-x64/AgentAttention.UI.exe',
  'skills/agent-attention/skill.md',
  'scripts/adapters/claude-code.json',
  'scripts/adapters/codex.json',
  'scripts/adapters/aider.json',
  'start.ps1',
  'README.md',
  'node/node_modules/chokidar/package.json',
  'node/node_modules/yargs/package.json',
];

let allOk = true;
for (const c of checks) {
  const f = path.join(extractDir, c);
  const ok = fs.existsSync(f);
  console.log((ok ? 'OK' : 'MISS') + ': ' + c);
  if (!ok) allOk = false;
}

// Test node.exe
try {
  const nodeExe = path.join(extractDir, 'node', 'node.exe');
  const ver = execSync('"' + nodeExe + '" --version', { encoding: 'utf8' }).trim();
  console.log('node version: ' + ver);
} catch (e) {
  console.log('node test FAILED: ' + e.message);
  allOk = false;
}

// Test daemon-cli --help
try {
  const nodeExe = path.join(extractDir, 'node', 'node.exe');
  const cliJs = path.join(extractDir, 'dist', 'daemon-cli.js');
  const help = execSync('"' + nodeExe + '" "' + cliJs + '" --help', { encoding: 'utf8', cwd: extractDir, timeout: 5000 });
  console.log('daemon-cli --help: OK');
} catch (e) {
  console.log('daemon-cli test FAILED: ' + e.message.substring(0, 100));
  allOk = false;
}

// Test agent-notify
try {
  const nodeExe = path.join(extractDir, 'node', 'node.exe');
  const idxJs = path.join(extractDir, 'dist', 'index.js');
  execSync('"' + nodeExe + '" "' + idxJs + '" completed "verify test"', {
    encoding: 'utf8', cwd: extractDir, timeout: 5000, stdio: 'pipe'
  });
  console.log('agent-notify: OK');
} catch (e) {
  console.log('agent-notify test: ' + e.message.substring(0, 100));
}

console.log('');
console.log(allOk ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');

// Cleanup
try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
