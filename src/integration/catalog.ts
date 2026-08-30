/**
 * Integration Capability Catalog
 *
 * Central registry of all known agents and their integration capabilities.
 * Replaces the old Adapter Registry with a richer manifest-based system.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  IntegrationManifest,
  IntegrationResult,
  IntegrationMechanism,
  ObservableInterface,
  CompletionReliability,
  IntegrationLevel,
  RELIABILITY_ORDER,
} from './types';

const CATALOG_DIR = path.join(__dirname, '..', '..', 'scripts', 'integrations');

/**
 * Load all integration manifests from the catalog directory.
 */
export function loadCatalog(): IntegrationManifest[] {
  const manifests: IntegrationManifest[] = [];
  try {
    if (!fs.existsSync(CATALOG_DIR)) return manifests;
    const files = fs.readdirSync(CATALOG_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(CATALOG_DIR, file), 'utf-8'),
        ) as IntegrationManifest;
        manifests.push(manifest);
      } catch {
        // Skip malformed manifests silently
      }
    }
  } catch {
    // Catalog directory unreadable — treat as empty
  }
  return manifests;
}

/**
 * Get manifest for a specific agent ID.
 */
export function getManifest(agentId: string): IntegrationManifest | null {
  const manifests = loadCatalog();
  return manifests.find((m) => m.id === agentId) ?? null;
}

/**
 * Check if an agent is installed on the system.
 */
export function isAgentInstalled(manifest: IntegrationManifest): boolean {
  // Check binary patterns first (try common variations)
  for (const pattern of manifest.binaryPatterns) {
    try {
      // Try `where` on Windows, `which` on Unix
      const isWin = process.platform === 'win32';
      const cmd = isWin ? `where.exe ${pattern} 2>nul` : `which ${pattern} 2>/dev/null`;
      const out = require('child_process').execSync(cmd, {
        encoding: 'utf-8', shell: true, timeout: 3000,
      }).trim();
      if (out) return true;
    } catch {}
  }
  // Check install paths
  if (manifest.installPaths) {
    for (const installPath of manifest.installPaths) {
      const expanded = installPath.replace('~', os.homedir());
      if (fs.existsSync(expanded)) return true;
    }
  }
  return false;
}

/**
 * Discover all installed agents and their achievable integration levels.
 */
export function discoverIntegrations(): IntegrationResult[] {
  const manifests = loadCatalog();
  const results: IntegrationResult[] = [];

  for (const manifest of manifests) {
    const installed = isAgentInstalled(manifest);
    const achievableLevel = installed ? manifest.level : IntegrationLevel.L0_CLI;
    const recommendedMechanism = getRecommendedMechanism(manifest, achievableLevel);

    results.push({
      manifest,
      installed,
      achievableLevel,
      recommendedMechanism,
      statusMessage: getIntegrationStatusMessage(manifest, installed, achievableLevel),
    });
  }

  return results;
}

/**
 * Get the recommended integration mechanism for a manifest.
 */
function getRecommendedMechanism(
  manifest: IntegrationManifest,
  level: IntegrationLevel,
): IntegrationMechanism {
  switch (level) {
    case IntegrationLevel.L7_NATIVE: return 'native';
    case IntegrationLevel.L6_ACP: return 'acp';
    case IntegrationLevel.L5_MCP: return 'mcp';
    case IntegrationLevel.L4_PLUGIN: return 'plugin';
    case IntegrationLevel.L3_HOOK: return 'hook';
    case IntegrationLevel.L2_WRAPPER: return 'wrapper';
    case IntegrationLevel.L1_SKILL: return 'skill';
    default: return 'cli';
  }
}

/**
 * Get a human-readable status message for integration discovery.
 */
function getIntegrationStatusMessage(
  manifest: IntegrationManifest,
  installed: boolean,
  level: IntegrationLevel,
): string {
  if (!installed) {
    return `${manifest.name}: Not installed (L${level} CLI only)`;
  }
  const levelNames: Record<IntegrationLevel, string> = {
    [IntegrationLevel.L0_CLI]: 'Manual CLI',
    [IntegrationLevel.L1_SKILL]: 'Skill',
    [IntegrationLevel.L2_WRAPPER]: 'Wrapper',
    [IntegrationLevel.L3_HOOK]: 'Hook',
    [IntegrationLevel.L4_PLUGIN]: 'Plugin',
    [IntegrationLevel.L5_MCP]: 'MCP',
    [IntegrationLevel.L6_ACP]: 'ACP',
    [IntegrationLevel.L7_NATIVE]: 'Native',
  };
  const reliability = getEffectiveReliability(manifest);
  const reliabilityLabel = reliability === CompletionReliability.Verified ? '✓' :
                           reliability === CompletionReliability.Probable ? '△' :
                           reliability === CompletionReliability.BestEffort ? '~' : '○';
  return `${manifest.name}: ${levelNames[level]} ${reliabilityLabel}`;
}

/**
 * Get the effective completion reliability for an agent.
 */
export function getEffectiveReliability(manifest: IntegrationManifest): CompletionReliability {
  const events = manifest.events;
  const reliabilities = Object.values(events).filter((r): r is CompletionReliability => !!r);
  if (reliabilities.length === 0) return CompletionReliability.Manual;
  // Return the highest reliability
  return reliabilities.reduce((max, r) =>
    RELIABILITY_ORDER[r] > RELIABILITY_ORDER[max] ? r : max
  , reliabilities[0]);
}

/**
 * Get the supported events for an agent.
 */
export function getSupportedEvents(manifest: IntegrationManifest): CompletionReliability[] {
  return Object.values(manifest.events).filter((r): r is CompletionReliability => !!r);
}

/**
 * Add a new manifest to the catalog.
 */
export function addManifest(manifest: IntegrationManifest): void {
  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  const filePath = path.join(CATALOG_DIR, `${manifest.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
}

/**
 * Update an existing manifest.
 */
export function updateManifest(manifest: IntegrationManifest): void {
  const current = getManifest(manifest.id);
  if (!current) {
    addManifest(manifest);
    return;
  }
  addManifest(manifest); // overwrite
}

/**
 * Remove a manifest from the catalog.
 */
export function removeManifest(agentId: string): boolean {
  const filePath = path.join(CATALOG_DIR, `${agentId}.json`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

/**
 * List all manifests with their levels.
 */
export function listManifests(): { id: string; name: string; level: IntegrationLevel; status: string }[] {
  return loadCatalog().map((m) => ({
    id: m.id,
    name: m.name,
    level: m.level,
    status: m.status ?? 'experimental',
  }));
}

// Fix: move RELIABILITY_ORDER import to top
