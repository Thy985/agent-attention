/**
 * Portable package builder for Agent Attention
 *
 * Creates a self-contained zip with Node.js runtime + app code.
 * Usage: node scripts/build-portable.mjs [--skip-download]
 */
import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, cpSync, rmSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir, tmpdir } from 'os';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import * as https from 'https';
import * as zlib from 'zlib';
import * as fs from 'fs';

const ARGV = process.argv.slice(2);
const SKIP_DOWNLOAD = ARGV.includes('--skip-download');

const ROOT = resolve(import.meta.dirname, '..');
const VERSION = '0.2.0';
const NODE_VERSION = '22.23.2';
const NODE_ARCH = 'win-x64';
const OUT_DIR = join(ROOT, 'dist', 'portable');
const NODE_URL = `https://nodejs.org/dist/latest-v${NODE_VERSION.split('.')[0]}.x/node-v${NODE_VERSION}-${NODE_ARCH}.zip`;
const PACKAGE_NAME = `agent-attention-${VERSION}-${NODE_ARCH}.zip`;

function log(msg, color = '') {
  const prefix = color ? `\x1b[${color}m` : '';
  const reset = '\x1b[0m';
  console.log(`${prefix}${msg}${reset}`);
}

function step(n, total, msg) {
  log(`[${n}/${total}] ${msg}`, '33');
}

function ok(msg) {
  log(`      ${msg}`, '32');
}

function err(msg) {
  log(`ERROR: ${msg}`, '31');
  process.exit(1);
}

// ── Step 1: Build TypeScript ─────────────────────────────────────────
step(1, 5, 'Building TypeScript...');
const tsc = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
if (tsc.status !== 0) err('TypeScript build failed');
ok('OK');

// ── Step 2: Build C# UI ──────────────────────────────────────────────
step(2, 5, 'Building C# UI...');
const dotnet = spawnSync('npm', ['run', 'publish:ui'], { cwd: ROOT, stdio: 'inherit' });
if (dotnet.status !== 0) err('C# build failed');
ok('OK');

// ── Step 3: Ensure Node.js portable ──────────────────────────────────
step(3, 5, `Preparing Node.js ${NODE_VERSION} portable...`);
const nodeDir = join(OUT_DIR, 'node');
if (!existsSync(nodeDir)) {
  if (SKIP_DOWNLOAD) {
    log('      SKIPPED (use --skip-download when Node.js is extracted)', '90');
  } else {
    const tempZip = join(tmpdir(), `node-${NODE_VERSION}-${NODE_ARCH}.zip`);
    if (existsSync(tempZip)) rmSync(tempZip, { force: true });
    mkdirSync(OUT_DIR, { recursive: true });

    log(`      Downloading from ${NODE_URL}`, '90');
    const download = spawnSync('curl', ['-L', '--output', tempZip, NODE_URL], { stdio: 'pipe' });
    if (download.status !== 0) {
      // Try Invoke-WebRequest as fallback
      const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command',
        `Invoke-WebRequest -Uri '${NODE_URL}' -OutFile '${tempZip.replace(/\\/g, '/')}' -UseBasicParsing`
      ], { stdio: 'pipe' });
      if (pwsh.status !== 0) err(`Download failed: ${NODE_URL}`);
    }
    const zipSize = (fs.statSync(tempZip).length / 1024 / 1024).toFixed(1);
    log(`      Downloaded ${zipSize} MB`, '90');

    log('      Extracting...', '90');
    const extract = spawnSync('7z', ['x', tempZip, `-o${OUT_DIR}`, '-y'], { stdio: 'pipe' });
    if (extract.status !== 0) err('Node.js extraction failed');
    rmSync(tempZip, { force: true });

    // Move extracted folder to node/
    const extracted = readdirSync(OUT_DIR).find(f => f.startsWith('node-v'));
    if (extracted) {
      const src = join(OUT_DIR, extracted);
      cpSync(src, nodeDir, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    }
  }
} else {
  log('      Node.js already present', '90');
}

// ── Step 4: Install dependencies ─────────────────────────────────────
step(4, 5, 'Installing dependencies...');
const nodeExe = join(nodeDir, 'node.exe');
const npmCli = join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const hasDeps = existsSync(join(nodeDir, 'node_modules', 'agent-attention'));

if (!hasDeps) {
  const stageDir = join(tmpdir(), 'agent-attention-portable-staging-1787806462861');
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true });
  mkdirSync(stageDir, { recursive: true });

  // Copy all app artifacts to staging
  if (existsSync(join(stageDir, 'dist'))) rmSync(join(stageDir, 'dist'), { recursive: true }); cpSync(join(ROOT, 'dist'), join(stageDir, 'dist'), { recursive: true, force: true });
  cpSync(join(ROOT, 'skills'), join(stageDir, 'skills'), { recursive: true });
  cpSync(join(ROOT, 'scripts', 'adapters'), join(stageDir, 'scripts', 'adapters'), { recursive: true });
  // Write minimal package.json (strip devDeps to avoid ERESOLVE)
  const miniPkg = JSON.parse(fs.readFileSync(join(ROOT, 'package.json'), 'utf8'));
  delete miniPkg.devDependencies; delete miniPkg.scripts;
  fs.writeFileSync(join(stageDir, 'package.json'), JSON.stringify(miniPkg, null, 2));
  copyFileSync(join(ROOT, 'README.md'), join(stageDir, 'README.md'));
  copyFileSync(join(ROOT, 'scripts', 'portable', 'start.ps1'), join(stageDir, 'start.ps1'));
  // C# binary
  const csharpSrc = join(ROOT, 'src', 'center', 'csharp', 'dist', 'win-x64');
  const csharpDst = join(stageDir, 'src', 'center', 'csharp', 'dist', 'win-x64');
  mkdirSync(dirname(csharpDst), { recursive: true });
  cpSync(csharpSrc, csharpDst, { recursive: true });

  log('      Running npm install...', '90');
  const npmResult = spawnSync(nodeExe, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: stageDir, stdio: 'pipe', encoding: 'utf8' });
  if (npmResult.status !== 0) {
    log(`      npm install failed: ${npmResult.stderr?.substring(0, 200) || 'unknown error'}`, '31');
    rmSync(stageDir, { recursive: true, force: true });
    process.exit(1);
  }
  if (npmResult.stderr) log(`      ${npmResult.stderr.trim().split('\n').slice(-3).join(' | ')}`, '90');

  // Move node_modules into node/
  cpSync(join(stageDir, 'node_modules'), join(nodeDir, 'node_modules'), { recursive: true });
  rmSync(stageDir, { recursive: true, force: true });
} else {
  log('      Dependencies already installed', '90');
}
ok('OK');

// ── Step 5: Create ZIP package ───────────────────────────────────────
step(5, 5, 'Creating portable package...');
const packagePath = join(OUT_DIR, PACKAGE_NAME);
if (existsSync(packagePath)) rmSync(packagePath, { force: true });

const zipStage = join(tmpdir(), `zip-stage-${Date.now()}`);
mkdirSync(zipStage, { recursive: true });

// Copy all contents
cpSync(nodeDir, join(zipStage, 'node'), { recursive: true });
cpSync(join(ROOT, 'dist'), join(zipStage, 'dist'), { recursive: true });
cpSync(join(ROOT, 'skills'), join(zipStage, 'skills'), { recursive: true });
cpSync(join(ROOT, 'scripts', 'adapters'), join(zipStage, 'scripts', 'adapters'), { recursive: true });
  cpSync(join(ROOT, 'src', 'center', 'csharp', 'dist', 'win-x64'), join(zipStage, 'src', 'center', 'csharp', 'dist', 'win-x64'), { recursive: true });
copyFileSync(join(ROOT, 'scripts', 'portable', 'start.ps1'), join(zipStage, 'start.ps1'));
copyFileSync(join(ROOT, 'README.md'), join(zipStage, 'README.md'));

// Zip it
const zipCmd = spawnSync('7z', ['a', packagePath, join(zipStage, '*')], { stdio: 'pipe' });
rmSync(zipStage, { recursive: true, force: true });

if (zipCmd.status !== 0) err('ZIP creation failed');

const pkgSize = (fs.statSync(packagePath).length / 1024 / 1024).toFixed(1);
log(`      Package: ${packagePath} (${pkgSize} MB)`, '32');

log('');
log('=== Build Complete ===', '32');
log(`Package: ${packagePath}`);
log('');
log('Contents:', '36');
log('  node\\               - Node.js portable runtime');
log('  dist\\                - TypeScript compiled code');
log('  skills\\              - Integration skill files');
log('  scripts\\adapters\\   - Agent adapter registry');
log('  start.ps1            - One-click launcher');
log('  README.md            - Quick start guide');
log('');
log(`To distribute: upload ${PACKAGE_NAME}`);
log('To use:        extract, then run: pwsh start.ps1');
