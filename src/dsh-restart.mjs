/**
 * DSH web-process restart helper for dsh-version-autoupdate.
 *  - With Watchdog (watchdog-web.lock): hand off — exit only; helper waits for health + writes outcome
 *  - Without Watchdog: spawn detached helper that starts the next process, health-checks, optional rollback
 *  - Windows: spawn absolute powershell.exe directly (never rely on PATH / cmd `start`)
 *
 * Log: ~/.dsh/version-autoupdate-restart.log
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

/** Watchdog reads this once, then deletes — boot from staging/live plan.cwd after handoff. */
export const WATCHDOG_NEXT_ROOT_NAME = 'watchdog-web.next-root';

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

export function detectSystemdManaged() {
  try { return /\.service(?:\/|$)/m.test(readFileSync('/proc/self/cgroup', 'utf8')) && Boolean(process.env.INVOCATION_ID || process.env.SYSTEMD_EXEC_PID); } catch { return false; }
}

function dshStateDir() {
  const dir = join(os.homedir(), '.dsh');
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

/** Prefer pwsh 7 (SkipHttpErrorCheck); fall back to Windows PowerShell 5.1 absolute path. */
export function resolveWindowsPowerShellPath(env = process.env) {
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const root = env.SystemRoot || env.WINDIR || 'C:\\Windows';
  const candidates = [
    join(pf, 'PowerShell', '7', 'pwsh.exe'),
    join(pf86, 'PowerShell', '7', 'pwsh.exe'),
    join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    join(root, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'powershell.exe';
}

/** Tell Watchdog which checkout to relaunch (staging scheme B or promoted live). */
export function writeWatchdogNextRoot(root, stateDir = dshStateDir()) {
  const trimmed = typeof root === 'string' ? root.trim() : '';
  if (!trimmed) return null;
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    const path = join(stateDir, WATCHDOG_NEXT_ROOT_NAME);
    writeFileSync(path, trimmed, 'utf8');
    return path;
  } catch (e) {
    appendRestartLog(`write next-root FAILED ${String((e && e.message) || e)}`);
    return null;
  }
}

function readWindowsProcessCommandLine(pid) {
  if (process.platform !== 'win32' || !pid) return '';
  try {
    const ps = resolveWindowsPowerShellPath();
    const out = execFileSync(
      ps,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { $p.CommandLine }`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    );
    return String(out || '').trim();
  } catch {
    return '';
  }
}

/**
 * Desktop "DSH Web" runs watch-dsh-web.ps1 which restarts dsh on exit.
 * Competing Start-Process from this helper races for :3080 and historically never even logged.
 * On Windows, require lock PID command line to mention watch-dsh-web.ps1 (avoid PID reuse false handoff).
 */
export function detectWatchdogHandoff(stateDir = dshStateDir()) {
  const lockFile = join(stateDir, 'watchdog-web.lock');
  if (!existsSync(lockFile)) return { handoff: false, lockFile, watchdogPid: null };
  let pid = 0;
  try {
    pid = parseInt(String(readFileSync(lockFile, 'utf8')).trim(), 10) || 0;
  } catch {
    return { handoff: false, lockFile, watchdogPid: null };
  }
  if (pid <= 0) return { handoff: false, lockFile, watchdogPid: null };
  try {
    process.kill(pid, 0);
  } catch {
    return { handoff: false, lockFile, watchdogPid: null };
  }
  if (process.platform === 'win32') {
    const cmd = readWindowsProcessCommandLine(pid);
    if (cmd && !/watch-dsh-web\.ps1/i.test(cmd)) {
      return { handoff: false, lockFile, watchdogPid: pid, reason: 'pid-not-watchdog' };
    }
  }
  return { handoff: true, lockFile, watchdogPid: pid };
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

export function retargetGithubPlan(plan, checkoutRoot) {
  const args = plan.args || [];
  const entry = args.findIndex(a => /(?:^|[/\\])bin\.(?:js|mjs|cjs|ts)$/.test(a));
  const web = args.indexOf('web');
  if (entry < 0 && web < 0) throw new Error('Cannot identify DSH CLI arguments for restart');
  const cliArgs = args.slice(entry >= 0 ? entry + 1 : web);
  const built = join(checkoutRoot, 'apps', 'cli', 'lib', 'bin.js');
  return { ...plan, exe: process.execPath, args: [built, ...cliArgs], cwd: checkoutRoot,
    port: plan.port || 3080, healthUrl: restartHealthUrl({ ...plan, args: cliArgs }), mode: 'github-built' };
}
export function restartHealthUrl(plan) {
  const args = plan.args || [];
  let host = '127.0.0.1';
  let port = plan.port || 3080;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host') host = args[++i] || host;
    else if (args[i].startsWith('--host=')) host = args[i].slice(7);
    else if (args[i] === '--port') port = Number(args[++i]) || port;
    else if (args[i].startsWith('--port=')) port = Number(args[i].slice(7)) || port;
  }
  if (host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::' || host === '[::]') host = '::1';
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  return `http://${host}:${port}/`;
}
function normalizeReexecLaunch(exe, args, cwd) {
  const joined = args.join(' ');
  const usesTsxSource = /bin\.ts/.test(joined) || (/--import/.test(joined) && /\btsx\b/.test(joined));
  if (usesTsxSource) {
    const fast = harnessWebLaunch(exe, cwd);
    if (fast?.mode === 'harness-built') {
      return { ...retargetGithubPlan({ exe, args }, cwd), mode: 'harness-built-upgrade' };
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

function argListPs(args) {
  return (args || []).map((a, i, arr) => {
    const comma = i < arr.length - 1 ? ',' : '';
    return `  ${psQuote(a)}${comma}`;
  }).join('\n');
}

/**
 * Build the Windows restart helper script (exported for unit tests).
 * Health failures inside the listen loop must retry until deadline — never rollback on first blip.
 */
export function buildWindowsRestartScript(input) {
  const {
    logFile,
    pid,
    port,
    plan,
    rollbackPlan = null,
    healthUrl,
    outcomeFile = '',
    operationId = '',
    compileCache = '',
    handoffWatchdog = false,
  } = input;

  const argLines = argListPs(plan.args);
  const rollbackArgLines = rollbackPlan ? argListPs(rollbackPlan.args) : '';

  const lines = [
    `$ErrorActionPreference = 'Continue'`,
    `$log = ${psQuote(logFile)}`,
    `function Log([string]$m) { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date).toString('o'), $m) -Encoding utf8 }`,
    // Align with Watchdog: 401/403 mean host is up (auth-gated). PS 5.1 throws on 4xx — read Response.StatusCode.
    `function Get-HealthStatus([string]$u) {`,
    `  try {`,
    `    $r = Invoke-WebRequest -Uri $u -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop`,
    `    return [int]$r.StatusCode`,
    `  } catch {`,
    `    try {`,
    `      $resp = $_.Exception.Response`,
    `      if ($null -ne $resp) {`,
    `        $code = 0`,
    `        try { $code = [int]$resp.StatusCode } catch { }`,
    `        if ($code -le 0) { try { $code = [int]$resp.StatusCode.value__ } catch { } }`,
    `        if ($code -gt 0) { return $code }`,
    `      }`,
    `    } catch { }`,
    `    throw`,
    `  }`,
    `}`,
    `function Test-HealthAcceptable([int]$code) { return ($code -ge 200 -and $code -lt 500) }`,
    `Log 'helper start pidToWait=${pid} port=${port} handoff=${handoffWatchdog ? '1' : '0'}'`,
    `$pidToWait = ${pid}`,
    `$port = ${port}`,
    `$handoff = $${handoffWatchdog ? 'true' : 'false'}`,
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
    `$outcomeFile = ${psQuote(outcomeFile)}`,
    `$operationId = ${psQuote(operationId)}`,
    `$healthUrl = ${psQuote(healthUrl)}`,
    `function Write-Outcome([string]$phase, [bool]$ok, [bool]$rolledBack, [string]$errorMsg) {`,
    `  if (-not $outcomeFile) { return }`,
    `  $payload = @{ ok = $ok; phase = $phase; rolledBack = $rolledBack; operationId = $operationId; error = $errorMsg; at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress`,
    `  Set-Content -LiteralPath $outcomeFile -Value $payload -Encoding utf8`,
    `}`,
    `$p = $null`,
  ];

  if (handoffWatchdog) {
    lines.push(
      `Log 'watchdog handoff: not starting a competing process; waiting for Watchdog to relaunch'`,
    );
  } else {
    lines.push(
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
      `  Write-Outcome 'failed' $false $false 'Start-Process failed'`,
      `  exit 1`,
      `}`,
    );
  }

  lines.push(
    `$deadline = (Get-Date).AddSeconds(150)`,
    `$stabilitySec = 25`,
    `while ((Get-Date) -lt $deadline) {`,
    `  $c = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)`,
    `  if ($c.Count -gt 0) {`,
    `    Log 'READY listen'`,
    `    try {`,
    `      $status = Get-HealthStatus $healthUrl`,
    `      if (Test-HealthAcceptable $status) {`,
    `        Log ("health ok status=$status; dwelling $($stabilitySec)s for boot stability")`,
    `        $owner = [int]($c[0].OwningProcess)`,
    `        $stableUntil = (Get-Date).AddSeconds($stabilitySec)`,
    `        $stable = $true`,
    `        while ((Get-Date) -lt $stableUntil) {`,
    `          Start-Sleep -Seconds 2`,
    `          $still = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)`,
    `          if ($still.Count -eq 0) { Log 'stability lost: port not listening'; $stable = $false; break }`,
    `          if ($owner -gt 0 -and -not (Get-Process -Id $owner -ErrorAction SilentlyContinue)) {`,
    `            $owner = [int]($still[0].OwningProcess)`,
    `            Log ("listener pid changed during dwell; tracking $owner")`,
    `          }`,
    `          try {`,
    `            $status2 = Get-HealthStatus $healthUrl`,
    `            if (-not (Test-HealthAcceptable $status2)) { Log ("stability lost: status=$status2"); $stable = $false; break }`,
    `          } catch {`,
    `            Log ("stability lost: $($_.Exception.Message)"); $stable = $false; break`,
    `          }`,
    `        }`,
    `        if ($stable) {`,
    `          Log 'health stable'`,
    `          Write-Outcome 'succeeded' $true $false ''`,
    `          exit 0`,
    `        }`,
    `      } else {`,
    `        Log ("health bad status=$status; will retry")`,
    `      }`,
    `    } catch {`,
    `      Log ("health not ready: $($_.Exception.Message); will retry")`,
    `    }`,
    `  }`,
    `  if (-not $handoff -and $p -and $p.HasExited) { Log ("child exited early code=$($p.ExitCode)"); Write-Outcome 'failed' $false $false 'child exited early'; exit 2 }`,
    `  Start-Sleep -Seconds 1`,
    `}`,
    `Log 'TIMEOUT waiting for listen/health'`,
  );

  if (handoffWatchdog) {
    lines.push(
      `Write-Outcome 'failed' $false $false 'listen/health timeout (watchdog handoff)'`,
      `exit 3`,
    );
  } else if (rollbackPlan) {
    lines.push(
      `$rbExe = ${psQuote(rollbackPlan.exe)}`,
      `$rbWd = ${psQuote(rollbackPlan.cwd)}`,
      `$rbArgs = @(\n${rollbackArgLines}\n)`,
      `Log 'health failed after deadline; rolling back'`,
      `try {`,
      `  if ($rbArgs.Count -gt 0) { Start-Process -FilePath $rbExe -ArgumentList $rbArgs -WorkingDirectory $rbWd -WindowStyle Hidden | Out-Null } else { Start-Process -FilePath $rbExe -WorkingDirectory $rbWd -WindowStyle Hidden | Out-Null }`,
      `  Write-Outcome 'rolled_back' $false $true 'health check failed'`,
      `} catch { Log ("rollback FAILED: $($_.Exception.Message)"); Write-Outcome 'failed' $false $false 'rollback failed' }`,
      `exit 4`,
    );
  } else {
    lines.push(
      `Write-Outcome 'failed' $false $false 'listen timeout'`,
      `exit 3`,
    );
  }

  return lines.join('\n');
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

  const plan = opts.plan || resolveRestartPlan();
  const rollbackPlan = opts.rollbackPlan || null;
  const healthUrl = opts.healthUrl || restartHealthUrl(plan);
  const outcomeFile = opts.outcomeFile || '';
  const operationId = opts.operationId || '';
  const pid = process.pid;
  const delayMs = Math.max(800, Number(opts.delayMs) || 2000);
  const port = plan.port || 3080;
  const stateDir = dshStateDir();
  const logFile = join(stateDir, 'version-autoupdate-restart.log');
  const reason = opts.reason || 'version-autoupdate';
  const watchdog = detectWatchdogHandoff(stateDir);
  const handoffWatchdog = Boolean(watchdog.handoff);
  const handoffSystemd = process.platform === 'linux' && detectSystemdManaged();
  restartScheduled = true;

  appendRestartLog(
    `schedule reason=${reason} mode=${plan.mode}${handoffWatchdog ? '+watchdog-handoff' : ''} pid=${pid} port=${port} exe=${plan.exe} cwd=${plan.cwd} args=${JSON.stringify(plan.args)} watchdogPid=${watchdog.watchdogPid ?? '-'}${watchdog.reason ? ` reason=${watchdog.reason}` : ''}`,
  );

  if (handoffWatchdog && plan.cwd) {
    const nextRootPath = writeWatchdogNextRoot(plan.cwd, stateDir);
    appendRestartLog(
      nextRootPath
        ? `watchdog next-root written path=${nextRootPath} cwd=${plan.cwd}`
        : `watchdog next-root WRITE FAILED cwd=${plan.cwd}`,
    );
  }

  try {
    const compileCache = process.env.NODE_COMPILE_CACHE || '';
    if (process.platform === 'win32') {
      const scriptPath = join(stateDir, `dsh-version-autoupdate-restart-${pid}.ps1`);
      const ps = buildWindowsRestartScript({
        logFile,
        pid,
        port,
        plan,
        rollbackPlan: handoffWatchdog ? null : rollbackPlan,
        healthUrl,
        outcomeFile,
        operationId,
        compileCache,
        handoffWatchdog,
      });
      writeFileSync(scriptPath, ps, 'utf8');
      const powershell = resolveWindowsPowerShellPath();
      const child = spawn(powershell, [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', scriptPath,
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: plan.cwd,
        env: process.env,
      });
      child.unref();
      appendRestartLog(`powershell helper launched script=${scriptPath} ps=${powershell} handoff=${handoffWatchdog ? 1 : 0}`);
    } else {
      const scriptPath = join(stateDir, `dsh-version-autoupdate-restart-${pid}.sh`);
      const argsJoined = (plan.args || []).map(shellQuote).join(' ');
      const rollbackArgsJoined = rollbackPlan ? (rollbackPlan.args || []).map(shellQuote).join(' ') : '';
      const sh = [
        '#!/bin/bash',
        'set +e',
        outcomeFile ? `trap ${shellQuote(`if [ ! -s ${shellQuote(outcomeFile)} ]; then printf '%s\\n' ${shellQuote(JSON.stringify({ok:false, phase:'failed',operationId,error:'restart helper exited before health success'}))} > ${shellQuote(outcomeFile)}; fi`)} EXIT` : 'true',
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
        (handoffWatchdog || handoffSystemd) ? 'log supervisor_handoff' : `nohup ${shellQuote(plan.exe)} ${argsJoined} >>"$LOG" 2>&1 &`,
        (handoffWatchdog || handoffSystemd) ? 'newpid=' : 'newpid=$!',
        'log "started newPid=$newpid"',
        'ready=0',
        'for i in $(seq 1 150); do',
        '  ready=0',
        '  if command -v ss >/dev/null 2>&1; then ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN && ready=1; fi',
        '  if command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && ready=1; fi',
        '  if [ "${ready:-0}" = "1" ]; then',
        `    log READY`,
        `    if curl -fsS -o /dev/null -w '%{http_code}' ${shellQuote(healthUrl)} | grep -Eq '^[2-4][0-9][0-9]$'; then`,
        `      log 'health_ok; dwelling 25s for boot stability'`,
        '      stable=1',
        '      for j in $(seq 1 13); do',
        '        sleep 2',
        '        still=0',
        '        if command -v ss >/dev/null 2>&1; then ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN && still=1; fi',
        '        if command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && still=1; fi',
        '        if [ "${still:-0}" != "1" ]; then log stability_lost_port; stable=0; break; fi',
        `        if ! curl -fsS -o /dev/null -w '%{http_code}' ${shellQuote(healthUrl)} | grep -Eq '^[2-4][0-9][0-9]$'; then log stability_lost_http; stable=0; break; fi`,
        '      done',
        '      if [ "$stable" = "1" ]; then',
        '        log health_stable',
        outcomeFile ? `        printf '%s\\n' ${shellQuote(JSON.stringify({ ok: true, phase: 'succeeded', rolledBack: false, operationId, error: '', at: new Date().toISOString() }))} > ${shellQuote(outcomeFile)}` : '        true',
        '        exit 0',
        '      fi',
        '    fi',
        '    log health_not_ready_retry',
        '  fi',
        '  if [ -n "$newpid" ]; then kill -0 "$newpid" 2>/dev/null || { log child_exited; break; }; fi',
        '  sleep 1',
        'done',
        'log TIMEOUT',
        rollbackPlan ? `cd ${shellQuote(rollbackPlan.cwd)} || exit 1` : '',
        rollbackPlan ? `log rollback_start` : '',
        rollbackPlan ? `nohup ${shellQuote(rollbackPlan.exe)} ${rollbackArgsJoined} >>"$LOG" 2>&1 &` : '',
        outcomeFile && rollbackPlan
          ? `printf '%s\\n' ${shellQuote(JSON.stringify({ ok: false, phase: 'rolled_back', rolledBack: true, operationId, error: 'health check failed', at: new Date().toISOString() }))} > ${shellQuote(outcomeFile)}`
          : (outcomeFile ? `printf '%s\\n' ${shellQuote(JSON.stringify({ ok: false, phase: 'failed', rolledBack: false, operationId, error: 'listen timeout', at: new Date().toISOString() }))} > ${shellQuote(outcomeFile)}` : 'true'),
        'exit 3',
      ].filter((line) => line !== '').join('\n');
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
    handoffWatchdog,
    message: handoffWatchdog
      ? '即将退出并由 Watchdog 按 next-root 自动拉起新版本…'
      : '即将自动重启以加载新版本…',
  };
}

/**
 * After staging build: write job, spawn promote-and-boot.mjs, then exit host.
 * Promote mutates live only after this process is gone (no half-tree boot).
 */
export function schedulePromoteAndBoot(opts = {}) {
  if (restartScheduled) {
    return {
      ok: true,
      already: true,
      restartScheduled: true,
      platform: process.platform,
      message: 'promote-and-boot 已在排队…',
    };
  }
  const jobPath = opts.jobPath;
  if (!jobPath || !existsSync(jobPath)) {
    return { ok: false, error: 'promote job file missing', message: 'promote job file missing' };
  }
  const helper = opts.helperPath || join(dirname(fileURLToPath(import.meta.url)), 'promote-and-boot.mjs');
  if (!existsSync(helper)) {
    return { ok: false, error: `missing ${helper}`, message: `missing promote-and-boot helper` };
  }
  const delayMs = Math.max(800, Number(opts.delayMs) || 2000);
  const stateDir = dshStateDir();
  const logFile = join(stateDir, 'version-autoupdate-restart.log');
  restartScheduled = true;
  appendRestartLog(`schedulePromoteAndBoot job=${jobPath} helper=${helper} pid=${process.pid}`);

  try {
    const child = spawn(process.execPath, [helper, jobPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
      cwd: opts.cwd || process.cwd(),
    });
    child.unref();
    appendRestartLog(`promote-and-boot launched pid=${child.pid} log=${logFile}`);
  } catch (e) {
    restartScheduled = false;
    const msg = String((e && e.message) || e);
    appendRestartLog(`schedulePromoteAndBoot FAILED ${msg}`);
    return { ok: false, error: msg, message: msg };
  }

  const exitSoon = () => {
    appendRestartLog('attempting process.exit(0) after promote-and-boot schedule');
    try {
      process.exitCode = 0;
      process.exit(0);
    } catch { /* ignore */ }
    try {
      process.kill(process.pid);
    } catch { /* ignore */ }
  };
  setTimeout(exitSoon, delayMs);

  const watchdog = detectWatchdogHandoff(stateDir);
  return {
    ok: true,
    restartScheduled: true,
    delayMs,
    platform: process.platform,
    handoffWatchdog: Boolean(watchdog.handoff),
    message: watchdog.handoff
      ? '即将退出；promote helper 将改 live，再由 Watchdog 按 next-root 拉起…'
      : '即将退出；promote helper 将改 live 并自动拉起新版本…',
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
