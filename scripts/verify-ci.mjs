#!/usr/bin/env node
/** Explicit layer report. Never labels an unrun installed-exe/desktop test passed. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const windows=process.argv.includes('--windows');
if(windows && process.platform!=='win32')throw new Error('--windows requires a real Windows runner');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'aa-ci-state-'));
const output=path.resolve(process.env.AGENT_ATTENTION_CI_OUT||path.join(root,'artifacts/ci'));
fs.mkdirSync(output,{recursive:true});
const report={platform:process.platform,node:process.version,steps:[],desktopAcceptance:{status:'not-run',reason:'Requires #6 interactive Windows/Linux desktop acceptance'},liveProvider:{status:'not-run',reason:'Requires real authorized provider session'}};
const env={...process.env,AGENT_ATTENTION_HOME:home,AGENT_ATTENTION_PACKAGE_REPORT:process.env.AGENT_ATTENTION_PACKAGE_REPORT||path.join(output,'package.json')};
function run(name,command,args){
  const p=spawnSync(command,args,{cwd:root,env,stdio:'inherit'});
  report.steps.push({name,status:!p.error&&p.status===0?'passed':'failed',exit:p.status,error:p.error?.message});
  if(p.error||p.status!==0)throw new Error(`${name} failed`);
}
try{
  run('TypeScript build',process.execPath,['node_modules/typescript/bin/tsc']);
  run('production-linked C# IPC harness','dotnet',['run','--project','tests/ipc-client-harness/IpcClientHarness.csproj','-c','Release']);
  run('production-linked UI command/evidence harness (no desktop rendering)','dotnet',['run','--project','tests/ui-contract-harness/UiContractHarness.csproj','-c','Release']);
  if(windows){
    run('publish Windows UI','dotnet',['publish','src/center/csharp/AgentAttention.UI/AgentAttention.UI.csproj','-c','Release','-r','win-x64','--self-contained','true','-o','src/center/csharp/dist/win-x64']);
    run('Windows UI harness','dotnet',['run','--project','src/center/csharp/AgentAttention.UI.Harness/AgentAttention.UI.Harness.csproj','-c','Release']);
  }
  const jest=['node_modules/jest/bin/jest.js','--runInBand','--forceExit','--json','--outputFile',path.join(output,'jest.json')];
  if(!windows){
    jest.push('--testNamePattern','^(?!.*(?:resolveNativeUiPath finds real artifact in installed layout|resolveNativeUiPath resolves to real executable)$).*');
    report.steps.push({name:'two installed Windows EXE assertions',status:'not-run',reason:'Only the two named real-EXE assertions are platform-partitioned; source/path-negative checks still run. Full suite runs in Windows lane after UI publish'});
  }
  run(windows?'full Jest with published Windows UI':'Linux Jest (Windows installed-EXE suites reported separately)',process.execPath,jest);
  run('pack + isolated installed-package smoke',process.execPath,['scripts/verify-package.mjs',...(windows?['--windows-ui']:[])]);
  report.status='passed-for-selected-layers';
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1;}
finally{fs.rmSync(home,{recursive:true,force:true});fs.writeFileSync(path.join(output,'layers.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
