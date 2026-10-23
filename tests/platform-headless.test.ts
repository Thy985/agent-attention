import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { spawn, spawnSync } from 'child_process';
import { receiveEvent } from '../src/core/receive';
import { readState, clearUnread } from '../src/state/AttentionState';
import { resolveStateDir } from '../src/paths';

const root = path.resolve(__dirname, '..');
const linuxTest = process.platform === 'linux' ? test : test.skip;
function command(home: string, file: string, args: string[] = []) {
  return spawnSync(process.execPath, [path.join(root, 'dist', file), ...args], {
    env: { ...process.env, AGENT_ATTENTION_HOME: home, AGENT_ATTENTION_MODE: 'headless', AGENT_ID: 'linux-test' },
    encoding: 'utf8', timeout: 15000,
  });
}
function cli(home: string, ...args: string[]) {
  const r = command(home, 'daemon-cli.js', args);
  if (r.status !== 0) throw new Error(`${args.join(' ')}: ${r.stderr || r.error}`);
  return r.stdout.trim();
}
function parallel(home: string, expression: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', expression], {
      cwd: root, env: { ...process.env, AGENT_ATTENTION_HOME: home, AGENT_ATTENTION_MODE: 'headless' }, stdio: ['ignore','pipe','pipe'],
    });
    let err = ''; child.stderr.on('data', b => err += b);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(err)));
  });
}
function exchange(home: string, frames: any[], done: (frames: any[]) => boolean): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const port = Number(fs.readFileSync(path.join(home, 'ipc-port.txt'), 'utf8'));
    const socket = net.createConnection(port, '127.0.0.1');
    let buffer = ''; const received: any[] = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('IPC timeout')); }, 4000);
    socket.on('connect', () => socket.write(frames.map(f => JSON.stringify(f)).join('\n') + '\n'));
    socket.on('data', data => {
      buffer += data.toString(); let i;
      while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0,i); buffer = buffer.slice(i+1); if(line) received.push(JSON.parse(line)); }
      if (done(received)) { clearTimeout(timer); socket.destroy(); resolve(received); }
    });
    socket.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

linuxTest('real headless subprocess: persist, authenticated IPC, read, restart, unsupported desktop', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-linux-e2e-'));
  try {
    const first = JSON.parse(cli(home, 'daemon', 'start', '--headless')); expect(first.running).toBe(true);
    expect(JSON.parse(cli(home, 'daemon', 'start', '--headless')).pid).toBe(first.pid);
    const caps = JSON.parse(cli(home, 'capabilities')); expect(caps.mode).toBe('headless'); expect(caps.notification).toBe('unsupported');
    for (const event of ['completed', 'failed', 'input_required', 'permission_required']) {
      const r = command(home, 'index.js', [event, `test ${event}`]); expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ recorded: true, delivery: 'unsupported' });
    }
    let state = JSON.parse(cli(home, 'events')); expect(state.events).toHaveLength(4); expect(state.unreadCount).toBe(4);
    const denied = await exchange(home, [{ type:'cmd', requestId:'denied', command:'mark-all-read' }], f => f.some(x => x.type==='auth-rejected'));
    expect(denied[0].type).toBe('auth-rejected'); expect(JSON.parse(cli(home,'events')).unreadCount).toBe(4);
    const token = fs.readFileSync(path.join(home, 'ipc-auth.secret'), 'utf8');
    const frames = await exchange(home, [{type:'hello', token}, {type:'subscribe'}, {type:'cmd', requestId:'read', command:'mark-all-read', args:[]}], f => f.some(x => x.requestId==='read'));
    expect(frames.some(f => f.type==='daemon-status' && f.payload.status==='alive')).toBe(true);
    expect(frames.find(f => f.requestId==='read')).toMatchObject({ok:true});
    state = JSON.parse(cli(home,'events')); expect(state.unreadCount).toBe(0);
    const ids = state.events.map((e:any) => e.id);
    const restarted = JSON.parse(cli(home,'daemon','restart')); expect(restarted.pid).not.toBe(first.pid);
    state = JSON.parse(cli(home,'events')); expect(state.events.map((e:any)=>e.id)).toEqual(ids); expect(state.unreadCount).toBe(0);
    for (const name of ['tray.pid', 'tray-state.json']) expect(fs.existsSync(path.join(home,name))).toBe(false);
    expect(fs.statSync(path.join(home,'ipc-auth.secret')).mode & 0o777).toBe(0o600);
    expect(cli(home,'doctor')).toContain('headless');
    const setup = command(home,'daemon-cli.js',['setup']); expect(setup.status).toBe(1);
    expect(setup.stderr).toContain('no autostart');
    // Headless lifecycle must not delete another platform adapter's retained artifacts.
    fs.writeFileSync(path.join(home,'tray-state.json'),'sentinel-state');
    fs.writeFileSync(path.join(home,'tray.pid'),'sentinel-pid');
    cli(home,'daemon','stop');
    expect(fs.readFileSync(path.join(home,'tray-state.json'),'utf8')).toBe('sentinel-state');
    expect(fs.readFileSync(path.join(home,'tray.pid'),'utf8')).toBe('sentinel-pid');
  } finally { command(home, 'daemon-cli.js', ['daemon','stop']); fs.rmSync(home,{recursive:true,force:true}); }
}, 45000);

test('state directory precedence preserves legacy MCP alias', () => {
  const home=process.env.AGENT_ATTENTION_HOME, alias=process.env.AGENT_ATTENTION_STATE_DIR;
  try { delete process.env.AGENT_ATTENTION_HOME; process.env.AGENT_ATTENTION_STATE_DIR=path.join(os.tmpdir(),'alias'); expect(resolveStateDir()).toBe(path.resolve(os.tmpdir(),'alias')); process.env.AGENT_ATTENTION_HOME=path.join(os.tmpdir(),'canonical'); expect(resolveStateDir()).toBe(path.resolve(os.tmpdir(),'canonical')); }
  finally { if(home===undefined) delete process.env.AGENT_ATTENTION_HOME; else process.env.AGENT_ATTENTION_HOME=home; if(alias===undefined) delete process.env.AGENT_ATTENTION_STATE_DIR; else process.env.AGENT_ATTENTION_STATE_DIR=alias; }
});

test('separate writers preserve bounded events without lost updates; read marking cannot overwrite writes', async () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'aa-concurrent-'));
  try {
    const script = (n:number) => `const {recordEvent,clearUnread}=require('./dist/state');const p=require('path').join(process.env.AGENT_ATTENTION_HOME,'state.json'); for(let i=0;i<4;i++){recordEvent(p,{type:'completed',priority:'P2',agent_id:'${n}',agent_name:'test',title:'test',message:'event '+i,timestamp:Date.now()});if(i===1)clearUnread(p);}`;
    await Promise.all([0,1,2,3].map(n=>parallel(home,script(n))));
    const s=readState(path.join(home,'state.json')); expect(s.events).toHaveLength(16); expect(new Set(s.events.map(e=>e.id)).size).toBe(16);
    expect(s.unreadCount).toBe(s.events.filter(e=>!e.read).length);
    clearUnread(path.join(home,'state.json')); expect(readState(path.join(home,'state.json')).unreadCount).toBe(0);
  } finally {fs.rmSync(home,{recursive:true,force:true});}
},20000);

test('stable event retry preserves read state; dead transaction lock recovers; corrupt bytes retained', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'aa-lock-')); const file=path.join(home,'state.json');
  try {
    fs.writeFileSync(file+'.write-lock','2147483647');
    const event={type:'completed' as const,priority:'P2' as const,agent_id:'a',agent_name:'a',title:'done',message:'done',timestamp:Date.now(),session_id:'s',source_event_id:'1'};
    expect(receiveEvent(file,event).duplicate).toBe(false); clearUnread(file);
    expect(receiveEvent(file,{...event,timestamp:Date.now()+1}).duplicate).toBe(true); expect(readState(file).unreadCount).toBe(0);
    expect(receiveEvent(file,{...event,session_id:'s2'}).duplicate).toBe(false);
    fs.writeFileSync(file,'{broken'); receiveEvent(file,event);
    expect(fs.readFileSync(file+'.corrupt','utf8')).toBe('{broken'); expect(readState(file).version).toBe(1);
  } finally {fs.rmSync(home,{recursive:true,force:true});}
});

test('real MCP stdio query and read mutations share CLI state and canonical path over legacy alias', async () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'aa-mcp-loop-')); const alias=fs.mkdtempSync(path.join(os.tmpdir(),'aa-mcp-alias-'));
  const { Client }=require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport }=require('@modelcontextprotocol/sdk/client/stdio.js');
  const client=new Client({name:'acceptance-test',version:'1'}, {capabilities:{}});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/mcp-server.js')],env:{...process.env,AGENT_ATTENTION_HOME:home,AGENT_ATTENTION_STATE_DIR:alias,AGENT_ATTENTION_MODE:'headless'}});
  try {
    expect(command(home,'index.js',['completed','MCP shared test']).status).toBe(0);
    await client.connect(transport);
    const result=await client.callTool({name:'attention__get_events',arguments:{}});
    const data=JSON.parse(result.content[0].text); expect(data.unreadCount).toBe(1); expect(data.events[0].message).toBe('MCP shared test');
    const agents=await client.callTool({name:'attention__agents',arguments:{}}); expect(JSON.parse(agents.content[0].text).agents.some((a:any)=>a.agent_id==='linux-test')).toBe(true);
    await client.callTool({name:'attention__clear_events',arguments:{}});
    expect(JSON.parse(cli(home,'events')).unreadCount).toBe(0); expect(fs.existsSync(path.join(alias,'state.json'))).toBe(false);
  } finally {await client.close(); fs.rmSync(home,{recursive:true,force:true});fs.rmSync(alias,{recursive:true,force:true});}
},15000);

linuxTest('daemon recovers killed owner and concurrent starts select one live process', async () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'aa-killed-'));
  try {
    const first=JSON.parse(cli(home,'daemon','start')); process.kill(first.pid,'SIGKILL');
    await new Promise(resolve=>setTimeout(resolve,100));
    const start=`require('child_process').execFileSync(process.execPath,['dist/daemon-cli.js','daemon','start'],{env:process.env,stdio:'pipe'});`;
    await Promise.all([parallel(home,start),parallel(home,start),parallel(home,start)]);
    const status=JSON.parse(cli(home,'daemon','status')); expect(status.running).toBe(true); expect(status.pid).not.toBe(first.pid);
    expect(fs.readFileSync(path.join(home,'daemon.lock'),'utf8')).toBe(String(status.pid));
  } finally {command(home,'daemon-cli.js',['daemon','stop']);fs.rmSync(home,{recursive:true,force:true});}
},30000);
