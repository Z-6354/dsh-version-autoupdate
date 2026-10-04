/**
 * DSH web-process restart helper for dsh-version-autoupdate.
 *  - Windows: never auto-restart — caller shows manual hint
 *  - Linux/macOS: spawn a detached helper, then exit so the new process loads the update
 *
 * Log: ~/.dsh/version-autoupdate-restart.log
 */
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDshHome } from './dsh-home.mjs';
import { spawn } from 'node:child_process';

function psQuote(s) {
  return "'" + String(s ?? '').replace(/'/g, "''") + "'";
}

function shellQuote(s) {
  return "'" + String(s ?? '').replace(/'/g, `'\\''`) + "'";
}

function detectListenPort() {
  const argv = process.argv || [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1] && /^\d+$/.test(argv[i + 1])) {
      return parseInt(argv[i + 1], 10);
    }
    const m = /^--port=(\d+)$/.exec(argv[i]);
    if (m) return parseInt(m[1], 10);
  }
  return 3080;
}

function dshStateDir() {
  const dir = resolveDshHome();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch { /* ignore */ }
  return dir;
}

function appendRestartLog(line) {
  try {
    const p = join(dshStateDir(), 'version-autoupdate-restart.log');
    writeFileSync(p, `[${new Date().toISOString()}] ${line}\n`, { flag: 'a', encoding: 'utf8' });
  } catch { /* ignore */ }
}

export function autoRestartEnabled(cfg = {}) {
  if (process.platform === 'win32') return false;
  return cfg.autoRestart !== false;
}

export function manualRestartHint() {
  if (process.platform === 'win32') {
    return '请手动关闭并重新启动 dsh web 后生效。';
  }
  return '请重启 dsh web 后生效。';
}

function findDshBinJs(argv) {
  return (argv || []).find((a) => typeof a === 'string' && a.includes('@deepseek-ai/dsh') && /[/\\]bin\.js$/i.test(a)) || null;
}

function harnessBuiltBin(cwd) {
  const built = join(cwd, 'apps', 'cli', 'lib', 'bin.js');
  return existsSync(built) ? built : null;
}

function harnessWebLaunch(exe, cwd) {
  const built = harnessBuiltBin(cwd);
  if (built) {
    return { exe, args: [built, 'web', '--no-open'], mode: 'harness-built' };
  }
  const src = join(cwd, 'apps', 'cli', 'src', 'bin.ts');
  if (existsSync(src)) {
    return { exe, args: ['--import', 'tsx/esm', src, 'web', '--no-open'], mode: 'harness-tsx' };
  }
  return null;
}

function normalizeReexecLaunch(exe, args, cwd) {
  const joined = args.join(' ');
  const usesTsxSource = /bin\.ts/.test(joined) || (/--import/.test(joined) && /\btsx\b/.test(joined));
  if (usesTsxSource) {
    const fast = harnessWebLaunch(exe, cwd);
    if (fast?.mode === 'harness-built') {
      return { exe: fast.exe, args: fast.args, mode: 'harness-built-upgrade' };
    }
  }
  return { exe, args, mode: 'reexec' };
}

export function resolveRestartPlan() {
  const exe = process.execPath;
  const execArgv = Array.isArray(process.execArgv) ? process.execArgv.slice() : [];
  const args = execArgv.concat((process.argv || []).slice(1));
  const cwd = process.cwd();
  const port = detectListenPort();
  const joined = args.join(' ');
  if (/\bweb\b/.test(joined) || /bin\.ts/.test(joined) || /(^|[\\/])dsh(\.cmd|\.exe)?$/i.test(exe) || /\bdsh\b/.test(joined)) {
    const launch = normalizeReexecLaunch(exe, args, cwd);
    return { exe: launch.exe, args: launch.args, cwd, port, mode: launch.mode };
  }
  const harness = harnessWebLaunch(exe, cwd);
  if (harness) {
    return { ...harness, cwd, port };
  }
  const dshBinJs = findDshBinJs(process.argv);
  if (dshBinJs) {
    return {
      exe,
      args: [dshBinJs, 'web', '--no-open'],
      cwd,
      port: detectListenPort(),
      mode: 'dsh-binjs',
    };
  }
  return {
    exe: process.platform === 'win32' ? 'cmd.exe' : 'dsh',
    args: process.platform === 'win32' ? ['/c', 'dsh', 'web', '--no-open'] : ['web', '--no-open'],
    cwd,
    port: detectListenPort(),
    mode: 'dsh-path',
  };
}

let restartScheduled = false;

export function isRestartScheduled() {
  return restartScheduled;
}

/**
 * @param {{ reason?: string, delayMs?: number, cfg?: Record<string, unknown> }} [opts]
 */
export function scheduleProcessRestart(opts = {}) {
  if (restartScheduled) {
    return {
      ok: true,
      already: true,
      restartScheduled: true,
      platform: process.platform,
      message: '重启已在排队…',
    };
  }
  if (!opts.force && !autoRestartEnabled(opts.cfg || {})) {
    return {
      ok: false,
      skipped: true,
      platform: process.platform,
      message: manualRestartHint(),
    };
  }

  const plan = resolveRestartPlan();
  const pid = process.pid;
  const delayMs = Math.max(800, Number(opts.delayMs) || 2000);
  const port = plan.port || 3080;
  const stateDir = dshStateDir();
  const logFile = join(stateDir, 'version-autoupdate-restart.log');
  const reason = opts.reason || 'version-autoupdate';
  restartScheduled = true;

  appendRestartLog(`schedule reason=${reason} mode=${plan.mode} pid=${pid} port=${port} exe=${plan.exe} cwd=${plan.cwd} args=${JSON.stringify(plan.args)}`);

  try {
    const compileCache = process.env.NODE_COMPILE_CACHE || '';
    if (process.platform === 'win32') {
      const scriptPath = join(stateDir, `dsh-version-autoupdate-restart-${pid}.ps1`);
      const argLines = (plan.args || []).map((a, i, arr) => {
        const comma = i < arr.length - 1 ? ',' : '';
        return `  ${psQuote(a)}${comma}`;
      }).join('\n');
      const ps = [
        `$ErrorActionPreference = 'Continue'`,
        `$log = ${psQuote(logFile)}`,
        `function Log([string]$m) { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date).toString('o'), $m) -Encoding utf8 }`,
        `Log 'helper start pidToWait=${pid} port=${port}'`,
        `$pidToWait = ${pid}`,
        `$port = ${port}`,
        `$script:waitStart = Get-Date`,
        compileCache
          ? `if (${psQuote(compileCache)} -ne '') { $env:NODE_COMPILE_CACHE = ${psQuote(compileCache)} }`
          : `# no NODE_COMPILE_CACHE`,
        `$deadline = (Get-Date).AddSeconds(120)`,
        `while ((Get-Date) -lt $deadline) {`,
        `  if (-not (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue)) { Log 'parent exited'; break }`,
        `  if (((Get-Date) - $script:waitStart).TotalSeconds -ge 12) {`,
        `    Log 'force-stopping parent'`,
        `    Stop-Process -Id $pidToWait -Force -ErrorAction SilentlyContinue`,
        `    break`,
        `  }`,
        `  Start-Sleep -Milliseconds 400`,
        `}`,
        `Start-Sleep -Seconds 1`,
        `$deadline = (Get-Date).AddSeconds(60)`,
        `while ((Get-Date) -lt $deadline) {`,
        `  $c = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)`,
        `  if ($c.Count -eq 0) { Log 'port free'; break }`,
        `  Start-Sleep -Milliseconds 500`,
        `}`,
        `$exe = ${psQuote(plan.exe)}`,
        `$wd = ${psQuote(plan.cwd)}`,
        `$argList = @(\n${argLines}\n)`,
        `Log ("starting exe=$exe wd=$wd argc=$($argList.Count)")`,
        `try {`,
        `  if ($argList.Count -gt 0) {`,
        `    $p = Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $wd -WindowStyle Hidden -PassThru`,
        `  } else {`,
        `    $p = Start-Process -FilePath $exe -WorkingDirectory $wd -WindowStyle Hidden -PassThru`,
        `  }`,
        `  Log ("started newPid=$($p.Id)")`,
        `} catch {`,
        `  Log ("Start-Process FAILED: $($_.Exception.Message)")`,
        `  exit 1`,
        `}`,
        `$deadline = (Get-Date).AddSeconds(90)`,
        `while ((Get-Date) -lt $deadline) {`,
        `  $c = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)`,
        `  if ($c.Count -gt 0) { Log 'READY listen'; exit 0 }`,
        `  if ($p -and $p.HasExited) { Log ("child exited early code=$($p.ExitCode)"); exit 2 }`,
        `  Start-Sleep -Seconds 1`,
        `}`,
        `Log 'TIMEOUT waiting for listen'`,
        `exit 3`,
      ].join('\n');
      writeFileSync(scriptPath, ps, 'utf8');
      const child = spawn('cmd.exe', [
        '/c', 'start', 'DSHVersionAutoupdateRestart', '/MIN',
        'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: plan.cwd,
        env: process.env,
      });
      child.unref();
    } else {
      const scriptPath = join(stateDir, `dsh-version-autoupdate-restart-${pid}.sh`);
      const argsJoined = (plan.args || []).map(shellQuote).join(' ');
      const sh = [
        '#!/bin/bash',
        'set +e',
        `LOG=${shellQuote(logFile)}`,
        'log() { echo "[$(date -Iseconds)] $*" >> "$LOG"; }',
        `log 'helper start pidToWait=${pid} port=${port}'`,
        `pid=${pid}`,
        `port=${port}`,
        compileCache ? `export NODE_COMPILE_CACHE=${shellQuote(compileCache)}` : 'true',
        'for i in $(seq 1 120); do kill -0 "$pid" 2>/dev/null || { log parent_exited; break; }; if [ "$i" -ge 30 ]; then log force_kill_parent; kill -9 "$pid" 2>/dev/null; break; fi; sleep 0.4; done',
        'sleep 1',
        'for i in $(seq 1 60); do',
        '  if command -v ss >/dev/null 2>&1; then ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN || { log port_free; break; }',
        '  elif command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || { log port_free; break; }',
        '  else break; fi',
        '  sleep 0.5',
        'done',
        `cd ${shellQuote(plan.cwd)} || exit 1`,
        `log "starting ${plan.exe} ${argsJoined}"`,
        `nohup ${shellQuote(plan.exe)} ${argsJoined} >>"$LOG" 2>&1 &`,
        'newpid=$!',
        'log "started newPid=$newpid"',
        'for i in $(seq 1 90); do',
        '  if command -v ss >/dev/null 2>&1; then ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN && { log READY; exit 0; }',
        '  elif command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && { log READY; exit 0; }',
        '  fi',
        '  kill -0 "$newpid" 2>/dev/null || { log child_exited; exit 2; }',
        '  sleep 1',
        'done',
        'log TIMEOUT',
        'exit 3',
      ].join('\n');
      writeFileSync(scriptPath, sh, { encoding: 'utf8', mode: 0o755 });
      const child = spawn('bash', [scriptPath], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.unref();
      appendRestartLog(`bash helper launched script=${scriptPath}`);
    }
  } catch (e) {
    restartScheduled = false;
    const msg = String((e && e.message) || e);
    appendRestartLog(`schedule FAILED ${msg}`);
    return { ok: false, error: msg };
  }

  const exitSoon = () => {
    appendRestartLog('attempting process.exit(0)');
    try {
      process.exitCode = 0;
      process.exit(0);
    } catch { /* ignore */ }
    try {
      process.kill(process.pid);
    } catch { /* ignore */ }
  };
  setTimeout(exitSoon, delayMs);
  return {
    ok: true,
    restartScheduled: true,
    delayMs,
    port,
    platform: process.platform,
    message: '即将自动重启以加载新版本…',
  };
}

export function maybeAutoRestart(reason, cfg = {}) {
  if (!autoRestartEnabled(cfg)) {
    appendRestartLog(`skip autoRestart platform=${process.platform} reason=${reason || ''}`);
    return {
      ok: false,
      skipped: true,
      needRestart: true,
      platform: process.platform,
      restartScheduled: false,
      message: manualRestartHint(),
    };
  }
  return scheduleProcessRestart({ reason, cfg, delayMs: cfg.restartDelayMs });
}
