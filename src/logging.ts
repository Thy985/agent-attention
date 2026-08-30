import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export interface LogEntry {
  timestamp: string;       // ISO 8601
  component: string;       // which module emitted this
  level: LogLevel;
  event: string;           // structured event name (snake_case)
  message: string;
  correlation_id?: string; // links events across the notification chain
  context?: Record<string, unknown>;
  compliance_tracking?: { agent_id: string; expected: string; actual: string; result: string };
}

const MAX_LOG_LINES = 10_000; // rotate by line count to avoid unbounded growth

let _level: LogLevel = 'INFO';

/**
 * Resolve the runtime log file path. Respects AGENT_ATTENTION_HOME so test
 * runs (which set it to a temp dir) do not pollute the production
 * ~/.agent-attention/logs/runtime.jsonl — this is the root cause of the
 * spurious "state.json corrupted" entries that appeared in production logs
 * during the test suite.
 */
function logFilePath(): string {
  const base = process.env.AGENT_ATTENTION_HOME || path.join(os.homedir(), '.agent-attention');
  return path.join(base, 'logs', 'runtime.jsonl');
}

/** Set the minimum log level. Lower levels are filtered out. */
export function setLogLevel(level: LogLevel): void {
  const order: LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
  _level = order.includes(level) ? level : 'INFO';
}

/** Generate a short correlation ID for a notification chain. */
export function generateCorrelationId(): string {
  return 'corr_' + crypto.randomBytes(4).toString('hex');
}

/** Emit a structured log entry to the unified JSONL log file. */
export function log(opts: {
  component: string;
  level: LogLevel;
  event: string;
  message: string;
  correlation_id?: string;
  context?: Record<string, unknown>;
  compliance_tracking?: { agent_id: string; expected: string; actual: string; result: string };
}): void {
  // Filter by level
  const order: LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
  if (order.indexOf(opts.level) < order.indexOf(_level)) return;

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    component: opts.component,
    level: opts.level,
    event: opts.event,
    message: opts.message,
    ...(opts.correlation_id ? { correlation_id: opts.correlation_id } : {}),
    ...(opts.context ? { context: opts.context } : {}),
  };

  try {
    const logFile = logFilePath();
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf-8');
    // Rotate if too large
    rotateIfNeeded();
  } catch {
    // Best-effort: never crash the system over a log failure
  }

  // Also emit to stdout/stderr for immediate visibility
  const line = JSON.stringify(entry);
  if (opts.level === 'FATAL' || opts.level === 'ERROR') {
    process.stderr.write(`[agent-attention] ${line}\n`);
  } else if (opts.level === 'WARN') {
    process.stderr.write(`[agent-attention] WARN ${line}\n`);
  }
}

/** Rotate log if it exceeds MAX_LOG_LINES (keep last 8000). */
function rotateIfNeeded(): void {
  try {
    const logFile = logFilePath();
    if (!fs.existsSync(logFile)) return;
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length <= MAX_LOG_LINES) return;
    // Keep last 80%
    const keep = Math.floor(lines.length * 0.8);
    fs.writeFileSync(logFile, lines.slice(-keep).join('\n') + '\n', 'utf-8');
  } catch {}
}

/** Read recent log entries. Returns last N entries (most recent first). */
export function readLogs(n: number = 50): LogEntry[] {
  try {
    const logFile = logFilePath();
    if (!fs.existsSync(logFile)) return [];
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const entries = lines.map(l => {
      try { return JSON.parse(l) as LogEntry; } catch { return null; }
    }).filter((e): e is LogEntry => e !== null);
    return entries.slice(-n).reverse();
  } catch {
    return [];
  }
}

/** Find entries by correlation_id. */
export function findCorrelated(correlationId: string): LogEntry[] {
  const all = readLogs(500);
  return all.filter(e => e.correlation_id === correlationId);
}

/** Wipe the log file (for testing). */
export function wipeLog(): void {
  try { fs.unlinkSync(logFilePath()); } catch {}
}
