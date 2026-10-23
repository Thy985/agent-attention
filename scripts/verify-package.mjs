#!/usr/bin/env node
/** Pack/install smoke outside the checkout. No startup entries or real user configuration. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa package smoke '));
const report = { platform: process.platform, node: process.version, checks: [], desktopAcceptance: 'not-run', liveProvider: 'not-run' };
const npmCli = process.env.AGENT_ATTENTION_NPM_CLI || process.env.npm_execpath;
if (!npmCli || !fs.existsSync(npmCli)) throw new Error('Run via npm run verify:package, or set AGENT_ATTENTION_NPM_CLI to npm-cli.js');
const env = { ...process.env, AGENT_ATTENTION_HOME: path.join(temp,'state'), AGENT_ATTENTION_MODE:'headless', AGENT_ID:'package-smoke', NODE_PATH:'' };
let installed; let client;
function run(exe,args,cwd=temp,timeout=120000) {
  const p=spawnSync(exe,args,{cwd,env,encoding:'utf8',timeout,maxBuffer:10*1024*1024});
  if(p.error || p.status!==0) throw new Error(`${exe} ${args.join(' ')}: ${p.error?.message || p.stderr || p.stdout} (exit ${p.status})`);
  return p.stdout;
}
function check(name,fn){fn();report.checks.push({name,status:'passed'});console.log(`PASS ${name}`);}
function cli(...args){return run(process.execPath,[path.join(installed,'dist/daemon-cli.js'),...args]);}
function npm(...args){return run(process.execPath,[npmCli,...args]);}
try {
  run(process.execPath,['node_modules/typescript/bin/tsc'],root);
  // npm pack lifecycle is deliberately enabled: verify the real candidate, not a fabricated tree.
  const pack=JSON.parse(run(process.execPath,[npmCli,'pack','--json','--pack-destination',temp],root))[0];
  const tarball=path.join(temp,pack.filename); report.tarball=pack.filename;report.integrity=pack.integrity;
  const paths=new Set(pack.files.map(f=>f.path));
  const expected=['dist/index.js','dist/daemon-cli.js','dist/mcp-server.js','skills/agent-attention/skill.md','docs/PACKAGE-ACCEPTANCE.md','docs/EVENT-CONTRACT.md','docs/LINUX-HEADLESS.md',
    ...fs.readdirSync(path.join(root,'scripts/adapters')).filter(f=>f.endsWith('.json')).map(f=>'scripts/adapters/'+f),
    ...fs.readdirSync(path.join(root,'scripts/integrations')).filter(f=>f.endsWith('.json')).map(f=>'scripts/integrations/'+f)];
  check('tarball includes all three entrypoints, manifests, adapters and skill',()=>{for(const f of expected)assert(paths.has(f),`Missing ${f}`);});
  check('tarball excludes portable output, credentials and developer files',()=>{
    for(const f of paths)assert(!/(^|\/)(\.env|\.claude|node_modules|\.git)(\/|$)|^dist\/portable\//.test(f),`Unexpected ${f}`);
  });
  fs.writeFileSync(path.join(temp,'package.json'),'{"private":true}');
  npm('install','--ignore-scripts','--omit=dev','--no-audit','--no-fund','--package-lock=true',tarball);
  installed=path.join(temp,'node_modules',pack.name);
  check('isolated install is a real directory, not a checkout link',()=>assert(!fs.lstatSync(installed).isSymbolicLink()));
  check('CLI help and generated launcher shims',()=>{
    for(const [name,file] of [['agent-notify','index.js'],['agent-attention','daemon-cli.js']]){
      run(process.execPath,[path.join(installed,'dist',file),'--help']);
      const bin=path.join(temp,'node_modules/.bin',name+(process.platform==='win32'?'.cmd':'')); assert(fs.existsSync(bin));
      if(process.platform!=='win32')run(bin,['--help']);
    }
    const bin=path.join(temp,'node_modules/.bin/agent-attention-mcp'+(process.platform==='win32'?'.cmd':''));assert(fs.existsSync(bin));
    assert(fs.readFileSync(path.join(installed,'dist/mcp-server.js'),'utf8').startsWith('#!/usr/bin/env node\n'));
  });
  const req=createRequire(path.join(installed,'package.json'));
  check('installed resource loaders return their catalog',()=>{
    assert(req('./dist/discover').loadAdapters().length>=3);assert(req('./dist/integration/catalog').loadCatalog().length>=6);
  });
  check('event write and query from installed package',()=>{
    run(process.execPath,[path.join(installed,'dist/index.js'),'completed','Package smoke event']);
    const s=JSON.parse(cli('events'));assert.equal(s.unreadCount,1);assert.equal(s.events[0].message,'Package smoke event');
  });
  const {Client}=req('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport}=req('@modelcontextprotocol/sdk/client/stdio.js');
  client=new Client({name:'package-smoke',version:'1'},{capabilities:{}});
  // Execute the Unix npm launcher itself, including its shebang, not only node file.js.
  const transport=new StdioClientTransport({command:process.platform==='win32'?process.execPath:path.join(temp,'node_modules/.bin/agent-attention-mcp'),args:process.platform==='win32'?[path.join(installed,'dist/mcp-server.js')]:[],cwd:temp,env});
  await client.connect(transport);
  const tools=await client.listTools();assert(tools.tools.some(t=>t.name==='attention__get_events'));
  const result=await client.callTool({name:'attention__get_events',arguments:{}});assert.equal(JSON.parse(result.content[0].text).unreadCount,1);
  await client.callTool({name:'attention__clear_events',arguments:{}});assert.equal(JSON.parse(cli('events')).unreadCount,0);
  report.checks.push({name:'installed MCP stdio handshake, tools/list, read and mark-read',status:'passed'});
  await client.close();client=null;
  if(process.platform==='linux'){
    check('installed Linux daemon start, restart and read-state recovery',()=>{
      assert(JSON.parse(cli('daemon','start')).running);assert(JSON.parse(cli('daemon','restart')).running);
      const s=JSON.parse(cli('events'));assert.equal(s.events.length,1);assert.equal(s.unreadCount,0);
      assert(JSON.parse(cli('daemon','stop')).stopped);
    });
  }else report.checks.push({name:'Linux background lifecycle',status:'not-run',reason:'Linux only'});
  if(process.argv.includes('--windows-ui')){
    check('installed Windows UI resources and resolver',()=>{
      for(const f of ['AgentAttention.UI.exe','AgentAttention.UI.dll','AgentAttention.UI.runtimeconfig.json'])assert(fs.existsSync(path.join(installed,'src/center/csharp/dist/win-x64',f)),`Missing UI ${f}`);
      assert.equal(req('./dist/ui-host').resolveNativeUiPath(),path.join(installed,'src/center/csharp/dist/win-x64/AgentAttention.UI.exe'));
    });
    report.windowsPackageResources='passed (not desktop execution)';
  }else report.windowsPackageResources='not-run: this candidate does not claim Windows desktop readiness';
  if(process.env.AGENT_ATTENTION_PACKAGE_OUT){fs.mkdirSync(process.env.AGENT_ATTENTION_PACKAGE_OUT,{recursive:true});fs.copyFileSync(tarball,path.join(process.env.AGENT_ATTENTION_PACKAGE_OUT,pack.filename));}
  report.status='passed';
}catch(e){report.status='failed';report.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{
  if(client)await client.close().catch(()=>{});
  if(installed && process.platform==='linux'){try{cli('daemon','stop');}catch{}}
  fs.rmSync(temp,{recursive:true,force:true});
  const reportPath=process.env.AGENT_ATTENTION_PACKAGE_REPORT;
  if(reportPath){fs.mkdirSync(path.dirname(path.resolve(reportPath)),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify(report,null,2));
}
