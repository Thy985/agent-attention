/** Compatibility entry point: native settings.json, same installer as the CLI. */
import * as path from 'path';
import * as os from 'os';
import { installClaudeHooks } from '../integration/hook-settings';
const args = process.argv.slice(2);
const idx = args.indexOf('--project');
if (idx >= 0 && !args[idx + 1]) throw new Error('--project requires a directory');
const dir = args.includes('--global') ? os.homedir() : idx >= 0 ? args[idx + 1] : process.cwd();
console.log(installClaudeHooks(dir, path.resolve(__dirname, '..', 'daemon-cli.js')));
