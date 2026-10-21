import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { spawnSync } from 'child_process';
import { resolveNativeWatchPath } from '../src/paths';

const shortDir = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\aa-watch';
const longDir = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\aa-watch';

afterEach(() => jest.restoreAllMocks());

test('Windows expands an existing short-name file before native watch registration', () => {
  const lookup = jest.spyOn(fs.realpathSync, 'native').mockReturnValue(path.win32.join(longDir, 'state.json'));
  expect(resolveNativeWatchPath(path.win32.join(shortDir, 'state.json'), 'win32')).toBe(path.win32.join(longDir, 'state.json'));
  expect(lookup).toHaveBeenCalledWith(path.win32.join(shortDir, 'state.json'));
});

test('Windows expands existing ancestor when state file and child directories are absent', () => {
  jest.spyOn(fs.realpathSync, 'native').mockImplementation((input: fs.PathLike) => {
    if (String(input) === shortDir) return longDir;
    throw Object.assign(new Error('not yet created'), { code: 'ENOENT' });
  });
  expect(resolveNativeWatchPath(path.win32.join(shortDir, 'new', 'state.json'), 'win32')).toBe(path.win32.join(longDir, 'new', 'state.json'));
});

test('access errors are not hidden by falling back to an unsafe native watch path', () => {
  const error = Object.assign(new Error('denied'), { code: 'EACCES' });
  jest.spyOn(fs.realpathSync, 'native').mockImplementation(() => { throw error; });
  expect(() => resolveNativeWatchPath(path.win32.join(shortDir, 'state.json'), 'win32')).toThrow(error);
});

test('POSIX configured watch path is preserved', () => {
  const lookup = jest.spyOn(fs.realpathSync, 'native');
  expect(resolveNativeWatchPath('/tmp/alias/state.json', 'linux')).toBe('/tmp/alias/state.json');
  expect(lookup).not.toHaveBeenCalled();
});

test('native watcher receives write/atomic replace and is closed before directory removal', async () => {
  // On Windows use an actual 8.3 alias if this volume supports it. The same
  // write/replace/close checks still run on volumes with 8.3 naming disabled.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-watch-long-name-'));
  let input = home;
  if (process.platform === 'win32') {
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${home}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || 'Could not obtain Windows short path');
    input = result.stdout.trim();
    expect(fs.realpathSync.native(input)).toBe(fs.realpathSync.native(home));
  }
  const file = path.join(home, 'state.json');
  fs.writeFileSync(file, 'initial');
  const watchedPath = resolveNativeWatchPath(path.join(input, 'state.json'));
  if (process.platform === 'win32') expect(path.dirname(watchedPath)).toBe(fs.realpathSync.native(home));
  const watcher = chokidar.watch(watchedPath, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 } });
  const waitFor = (event: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { watcher.removeListener(event, onEvent); reject(new Error(`Missing ${event} event`)); }, 5000);
    const onEvent = () => { clearTimeout(timer); resolve(); };
    watcher.once(event, onEvent);
  });
  try {
    await waitFor('ready');
    const written = waitFor('change'); fs.writeFileSync(file, 'first'); await written;
    const changed = waitFor('change'); fs.writeFileSync(file + '.tmp', 'replacement'); fs.renameSync(file + '.tmp', file); await changed;
    expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
  } finally {
    await watcher.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 15000);
