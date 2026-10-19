import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retargetGithubPlan, restartHealthUrl } from '../lib/dsh-restart.mjs';
import { verifyNpmInstallTarget, readVerifiedInstalledVersion } from '../lib/npm-install-target.js';
import { runManualRollback } from '../lib/promote-and-boot.mjs';
import { versionCompare } from '../lib/semver.js';
import { restartOutcomePath } from '../lib/github-staging-paths.js';

// Execute tool control flow with the installer/check/scheduler boundaries stubbed.
// These tests never install DSH, terminate a process, start a helper or call a model.
const toolsSource = await readFile(new URL('../lib/update-tools.js', import.meta.url), 'utf8');
let check;
globalThis.__updaterRepairFixture = {
  defineTool:x=>x, runSourceAwareCheck:async()=>check,
  isOperationOrphaned:()=>false, summarizeOperation:()=>'', UpdateOperationStore:class {},
  applyRestartOutcome:async()=>null, watchUpdateProgress:async()=>({}),
  resolveUpdateChannel:async()=>({ok:true,transport:'official'}), versionCompare, restartOutcomePath,
};
const prelude = 'const {defineTool,runSourceAwareCheck,isOperationOrphaned,summarizeOperation,UpdateOperationStore,applyRestartOutcome,watchUpdateProgress,resolveUpdateChannel,versionCompare,restartOutcomePath}=globalThis.__updaterRepairFixture;\n';
const { registerUpdateTools } = await import('data:text/javascript;base64,'+Buffer.from(prelude+toolsSource.replace(/^import .*;\r?\n/gm,'')).toString('base64'));
function fixture(afterVersion, initial) {
  let op=initial, running=false;
  const defs=new Map(), events=[];
  const store={ snapshot:()=>op&&({...op}), isRunning:()=>running,
    load:async()=>{}, clearOrphanedIfNeeded:async()=>{},
    begin(input){running=true;op={id:'repair-op',...input,backupVersion:input.currentVersion};return {...op}},
    async beginPersisted(input){return this.begin(input)},
    async patch(p){Object.assign(op,p)}, appendTail(){},
    async finish(phase,error){events.push(phase);Object.assign(op,{phase,error});running=false},
  };
  const host={ctx:{tools:{register(d){defs.set(d.name,d);return ()=>{}}}},store,
    capabilities:{canInstall:true,canRestart:true}, dshHome:'/isolated',
    runNpmInstall:async()=>({afterVersion,tail:''}), invalidateInstalledCache(){},
    scheduleRestart(p){events.push(p);return {ok:true,restartScheduled:true,message:'scheduled'}},
    runGithubRollback:async old=>{events.push({restore:old.previousRef});await store.patch({phase:'promoting'});return {ok:true}},
  };
  registerUpdateTools(host); return {defs,store,events};
}
test('npm tool rejects wrong installed version and keeps restarting until health result',async()=>{
  check={source:'npm',transport:'official',currentVersion:'1.0.0',latestVersion:'2.0.0',updateAvailable:true};
  const wrong=fixture('1.0.0'); await wrong.defs.get('dsh_update').execute({restart:true}); await new Promise(setImmediate);
  assert.equal(wrong.store.snapshot().phase,'failed'); assert.deepEqual(wrong.events,['failed']);
  const good=fixture('2.0.0'); await good.defs.get('dsh_update').execute({restart:true}); await new Promise(setImmediate);
  assert.equal(good.store.snapshot().phase,'restarting'); assert.equal(good.events[0].operationId,'repair-op');
  assert.ok(good.events[0].outcomeFile.endsWith('restart-outcome.json')); assert.ok(!good.events.includes('succeeded'));
  const noRestart=fixture('2.0.0'); await noRestart.defs.get('dsh_update').execute({restart:false}); await new Promise(setImmediate);
  assert.equal(noRestart.store.snapshot().phase,'succeeded'); assert.deepEqual(noRestart.events,['succeeded']);
});
test('manual GitHub tool schedules restoration instead of restarting updated live',async()=>{
  const f=fixture(null,{id:'old-op',source:'github',phase:'succeeded',currentVersion:'2.0.0',backupVersion:'1.0.0',liveRoot:'/live',previousRef:'old-ref'});
  const result=await f.defs.get('dsh_update_rollback').execute({});
  assert.equal(result.ok,true); assert.deepEqual(f.events,[{restore:'old-ref'}]); assert.equal(f.store.snapshot().phase,'promoting');
});
test('GitHub retarget preserves the original CLI options and health endpoint',()=>{
  const cli=['web','--host','127.0.0.1','--port=4099','--trusted-host','example.test','--profile','custom','--patch','local.yml','--no-open'];
  const p=retargetGithubPlan({args:['--import','tsx/esm','/old/apps/cli/src/bin.ts',...cli],port:4099},'/new');
  assert.deepEqual(p.args.slice(1),cli); assert.equal(restartHealthUrl(p),'http://127.0.0.1:4099/');
});
test('npm verifies actual global root and installed target version',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'updater-target-'));
  try {
    const globalRoot=join(temp,'global'), live=join(globalRoot,'@deepseek-ai','dsh'), other=join(temp,'other');
    await mkdir(live,{recursive:true}); await mkdir(other); await writeFile(join(live,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'2.0.0'}));
    const ctx={get:n=>n==='timer'?{timeout:()=>()=>{}}:{spawn:()=>({done:Promise.resolve({exitCode:0}),collected:{stdout:{readFrom:()=>({text:globalRoot})}}})}};
    await verifyNpmInstallTarget(ctx,'npm',live); await assert.rejects(verifyNpmInstallTarget(ctx,'npm',other),/differs/);
    assert.equal(readVerifiedInstalledVersion(live,'2.0.0'),'2.0.0'); assert.throws(()=>readVerifiedInstalledVersion(live,'3.0.0'),/mismatch/);
  } finally {await rm(temp,{recursive:true,force:true})}
});
test('manual rollback restores git/artifacts, relinks, boots then waits for health',async()=>{
  const home=await mkdtemp(join(tmpdir(),'updater-rollback-')), events=[];
  try {
    const job={operationId:'rb',dshHome:home,stateDir:home,liveRoot:'/live',previousRef:'old-ref',artifactBackupRoot:'/backup',
      rollbackPlan:{exe:'node',cwd:'/live',args:['bin.js','web'],port:4099},healthUrl:'http://127.0.0.1:4099/',outcomeFile:join(home,'outcome.json')};
    await runManualRollback(job,{handoff:false,killListeners:()=>events.push('stop'),
      restore:async opts=>{assert.equal(opts.previousRef,'old-ref');assert.equal(opts.artifactBackupRoot,'/backup');events.push('restore');return {artifactsRestored:true}},
      relink:async()=>events.push('relink'),startPlan:()=>events.push('boot'),waitHealth:async()=>{events.push('health');return true}});
    assert.deepEqual(events,['stop','restore','relink','boot','health']);
    assert.equal(JSON.parse(await readFile(job.outcomeFile,'utf8')).phase,'rolled_back');
  } finally {await rm(home,{recursive:true,force:true})}
});
