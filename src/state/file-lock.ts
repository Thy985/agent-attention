import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
const held = new Set<string>();
function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function deadOwner(file: string): boolean {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!/^\d+$/.test(raw)) return false;
    try { process.kill(Number(raw), 0); return false; } catch (err: any) { return err.code === 'ESRCH'; }
  } catch { return false; }
}
// Publish complete ownership atomically. A crash between open and write cannot leave an empty lock.
function claim(file: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, String(process.pid), { flag: 'wx', mode: 0o600 }); fs.linkSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
/** Local-filesystem synchronous transactions shared by CLI, MCP and daemon.
 * Dead owners recover; live/malformed locks time out explicitly, never silently discard a write.
 * Not a distributed/network-filesystem lock and not an exactly-once delivery mechanism.
 */
export function withFileLock<T>(file: string, fn: () => T): T {
  const lock = path.resolve(file) + '.write-lock';
  if (held.has(lock)) return fn();
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const recovering = lock + '.recover';
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      if (fs.existsSync(recovering)) throw Object.assign(new Error('recovery in progress'), { code: 'EEXIST' });
      claim(lock); break;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      if (deadOwner(lock)) {
        let guarded = false;
        try { claim(recovering); guarded = true; if (deadOwner(lock)) fs.unlinkSync(lock); }
        catch (recoverErr: any) { if (recoverErr.code !== 'EEXIST' && recoverErr.code !== 'ENOENT') throw recoverErr; }
        finally { if (guarded) { try { fs.unlinkSync(recovering); } catch {} } }
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring state transaction lock: ${lock}`);
      sleep(10);
    }
  }
  held.add(lock);
  try { return fn(); } finally { held.delete(lock); fs.unlinkSync(lock); }
}
