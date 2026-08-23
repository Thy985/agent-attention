import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Dedup TTL in milliseconds — same event+message within this window is suppressed. */
const DEDUP_TTL_MS = 30_000;

/**
 * Path to the persistent dedup log file (shared across all agent-notify invocations).
 * AGENT_ATTENTION_HOME overrides the base directory (used by tests and sandboxed runs).
 */
const DEDUP_LOG_PATH = path.join(
  process.env.AGENT_ATTENTION_HOME || path.join(os.homedir(), '.agent-attention'),
  'dedup.json',
);

/** In-process dedup cache to avoid file I/O on every call. */
const localCache = new Map<string, number>();

/**
 * Compute a hash key for deduplication: hash(JSON.stringify([agent,event,message])).
 * Using JSON.stringify avoids separator-collision bugs (e.g. "a:b:c" vs "a:b:c" parsed differently).
 */
function makeKey(agent: string, event: string, message: string): string {
  return crypto.createHash('sha1').update(JSON.stringify([agent, event, message])).digest('hex');
}

/** Persisted dedup log shape: { [key]: epochMs }. */
interface DedupLog {
  [key: string]: number;
}

/**
 * Read the dedup log from disk. Returns empty object on any failure.
 * Best-effort — never throws.
 */
function readLog(): DedupLog {
  try {
    if (!fs.existsSync(DEDUP_LOG_PATH)) return {};
    const raw = fs.readFileSync(DEDUP_LOG_PATH, 'utf-8');
    if (!raw.trim()) return {};
    return JSON.parse(raw) as DedupLog;
  } catch {
    return {};
  }
}

/**
 * Write the dedup log atomically (tmp + rename). Best-effort — never throws.
 */
function writeLog(log: DedupLog): void {
  try {
    fs.mkdirSync(path.dirname(DEDUP_LOG_PATH), { recursive: true });
    const tmp = `${DEDUP_LOG_PATH}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(log), 'utf-8');
    try {
      fs.renameSync(tmp, DEDUP_LOG_PATH);
    } catch (err: any) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
        fs.writeFileSync(DEDUP_LOG_PATH, JSON.stringify(log), 'utf-8');
      }
    }
    try { fs.unlinkSync(tmp); } catch {}
  } catch {
    // best-effort, never throw
  }
}

/**
 * Check whether a notification should be sent (dedup guard).
 * Returns true if this is a new notification, false if suppressed.
 *
 * P1-6 fix: dedup state now persists to disk (~/.agent-attention/dedup.json)
 * so it survives across separate agent-notify process invocations. Each
 * invocation still has its own in-memory cache for fast path; only the first
 * call within the process and the periodic eviction sync to disk.
 */
export function shouldNotify(agent: string, event: string, message: string): boolean {
  const now = Date.now();
  const key = makeKey(agent, event, message);

  // 1. Fast path — in-memory cache (cheap, avoids disk I/O)
  const localTs = localCache.get(key);
  if (localTs !== undefined) {
    if (now - localTs <= DEDUP_TTL_MS) {
      return false; // suppressed in this process
    }
    localCache.delete(key);
  }

  // 2. Slow path — check persisted log (survives across process invocations)
  const log = readLog();
  let mutated = false;
  // Evict expired entries
  for (const k of Object.keys(log)) {
    if (now - log[k] > DEDUP_TTL_MS) {
      delete log[k];
      mutated = true;
    }
  }
  if (log[key] !== undefined) {
    // Already seen within TTL — suppress and skip write
    if (mutated) writeLog(log);
    localCache.set(key, log[key]);
    return false;
  }

  // 3. Accept: record and persist
  log[key] = now;
  writeLog(log);
  localCache.set(key, now);
  return true;
}
