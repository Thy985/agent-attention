import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as chokidar from 'chokidar';
import childProcess = require('child_process');
import { resolveNativeWatchPath } from '../src/paths';

const shortDir = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\aa-watch';
const longDir = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\aa-watch';

afterEach(() => jest.restoreAllMocks());

// cmd.exe does not use the CRT argv quoting rules that Node applies by default.
// Keep the shell program literal and pass the path as data; otherwise Node's
// escaped quotes can become part of %~sI's output (for example D:\"C:\...\").
function windowsShortPath(home: string): string {
  const result = childProcess.spawnSync('cmd.exe', ['/d', '/s', '/c', 'for %I in ("%AA_WATCH_TEST_HOME%") do @echo %~sI'], {
    encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true,
    env: { ...process.env, AA_WATCH_TEST_HOME: home },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'Could not obtain Windows short path');
  const output = result.stdout.trim();
  if (!path.win32.isAbsolute(output) || /["\r\n]/.test(output)) {
    throw new Error(`Invalid Windows short-path output: ${JSON.stringify(output)}`);
  }
  return output;
}

test('Windows short-path command uses verbatim shell syntax and passes the path as environment data', () => {
  const home = 'C:\\Temp\\watch space & percent% (unicode-路径)';
  const alias = 'C:\\Temp\\WATCHS~1';
  const spawn = jest.spyOn(childProcess, 'spawnSync').mockReturnValue({ status: 0, stdout: alias + '\r\n', stderr: '' } as childProcess.SpawnSyncReturns<string>);
  expect(windowsShortPath(home)).toBe(alias);
  expect(spawn).toHaveBeenCalledWith('cmd.exe', ['/d', '/s', '/c', 'for %I in ("%AA_WATCH_TEST_HOME%") do @echo %~sI'], expect.objectContaining({
    encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true,
    env: expect.objectContaining({ AA_WATCH_TEST_HOME: home }),
  }));
});

test('Windows short-path lookup preserves a long path when 8.3 aliases are disabled', () => {
  jest.spyOn(childProcess, 'spawnSync').mockReturnValue({ status: 0, stdout: longDir + '\r\n', stderr: '' } as childProcess.SpawnSyncReturns<string>);
  expect(windowsShortPath(longDir)).toBe(longDir);
});

test.each(['D:\\"C:\\Temp\\aa-watch"', '"C:\\Temp\\aa-watch"', '', 'relative-path', 'C:\\Temp\\one\r\nC:\\Temp\\two'])('Windows short-path lookup rejects malformed output %j rather than hiding broken quoting', output => {
  jest.spyOn(childProcess, 'spawnSync').mockReturnValue({ status: 0, stdout: output, stderr: '' } as childProcess.SpawnSyncReturns<string>);
  expect(() => windowsShortPath(shortDir)).toThrow('Invalid Windows short-path output');
});

test('Windows short-path lookup reports process errors and nonzero exit status', () => {
  const spawn = jest.spyOn(childProcess, 'spawnSync');
  const error = Object.assign(new Error('cmd missing'), { code: 'ENOENT' });
  spawn.mockReturnValue({ error, status: null, pid: 0, output: [], stdout: '', stderr: '', signal: null });
  expect(() => windowsShortPath(shortDir)).toThrow(error);
  spawn.mockReturnValue({ status: 1, stdout: '', stderr: 'short-path lookup failed' } as childProcess.SpawnSyncReturns<string>);
  expect(() => windowsShortPath(shortDir)).toThrow('short-path lookup failed');
});


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
    input = windowsShortPath(home);
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
