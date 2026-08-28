const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = process.env.AGENT_ATTENTION_HOME || path.join(os.homedir(), '.agent-attention');
const REGISTRY_PATH = path.join(STATE_DIR, 'agents.json');
const INTEGRATIONS_PATH = path.join(STATE_DIR, 'integrations.json');

console.log('Agent Attention v2 → v3 migration helper');
console.log('State dir:', STATE_DIR);
console.log('');

let registry;
try {
  registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
} catch {
  console.error('Cannot read agents.json — run from a terminal with write access to ~/.agent-attention');
  process.exit(1);
}

console.log('Current version:', registry.version);
console.log('Agents:', registry.agents.length);

let dirty = false;
if (registry.version === 1) {
  for (const agent of registry.agents) {
    if (agent.target === undefined) agent.target = null;
  }
  registry.version = 2;
  dirty = true;
}
if (registry.version === 2) {
  for (const agent of registry.agents) {
    if (agent.binary === undefined) agent.binary = null;
    if (!agent.integration) agent.integration = 'none';
  }
  registry.version = 3;
  dirty = true;
}

let legacy = null;
try {
  legacy = JSON.parse(fs.readFileSync(INTEGRATIONS_PATH, 'utf8'));
} catch {}
if (legacy && Array.isArray(legacy.agents)) {
  for (const entry of legacy.agents) {
    if (!entry || !entry.id || entry.enabled === false) continue;
    const existing = registry.agents.find((a) => a.agent_id === entry.id);
    if (existing) {
      if (!existing.binary) existing.binary = entry.binary || null;
      if (!existing.integration || existing.integration === 'none') {
        existing.integration = 'adapter';
      }
    } else {
      registry.agents.push({
        agent_id: entry.id,
        name: entry.name || entry.id,
        binary: entry.binary || null,
        integration: 'adapter',
        registered_at: entry.registered_at || Date.now(),
        last_seen_at: entry.registered_at || Date.now(),
        target: null,
      });
    }
  }
  try { fs.unlinkSync(INTEGRATIONS_PATH); } catch { /* best-effort */ }
  console.log('Folded integrations.json entries into agents.json');
  dirty = true;
}

if (!dirty) {
  console.log('Already on v3 — nothing to migrate.');
  process.exit(0);
}

try {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');
  console.log('Migrated to v3 successfully!');
  for (const a of registry.agents) {
    console.log('  ' + a.agent_id + ' → integration=' + a.integration + ' binary=' + a.binary);
  }
} catch (err) {
  console.error('Write blocked (sandbox?): ' + err.message);
  console.error('Please run this script from a regular terminal:');
  console.error('  node scripts/migrate-v3.js');
  process.exit(1);
}
