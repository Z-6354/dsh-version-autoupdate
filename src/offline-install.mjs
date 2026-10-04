/**
 * Low-memory offline install: stop DSH → npm install -g → start DSH in a detached helper.
 * Log: ~/.dsh/version-autoupdate-offline.log
 * State: ~/.dsh/version-autoupdate-offline.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveDshHome } from './dsh-home.mjs';
import { spawn } from 'node:child_process';
import { resolveRestartPlan } from './dsh-restart.mjs';

function shellQuote(s) {
  return "'" + String(s ?? '').replace(/'/g, `'\\''`) + "'";
}

export function dshStateDir() {
  const dir = resolveDshHome();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch { /* ignore */ }
  return dir;
}

export function offlineLogFile() {
  return join(dshStateDir(), 'version-autoupdate-offline.log');
}

export function offlineStateFile() {
  return join(dshStateDir(), 'version-autoupdate-offline.json');
}

export function readOfflineState() {
  try {
    const raw = readFileSync(offlineStateFile(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeOfflineState(state) {
  writeFileSync(offlineStateFile(), JSON.stringify(state, null, 2), 'utf8');
}

/** Linux MemTotal from /proc/meminfo (MB), or null. */
export function readLinuxMemTotalMb() {
  if (process.platform !== 'linux') return null;
  try {
    const text = readFileSync('/proc/meminfo', 'utf8');
    const m = text.match(/MemTotal:\s+(\d+)\s+kB/i);
    if (!m) return null;
    return Math.round(parseInt(m[1], 10) / 1024);
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {number | null} memTotalMb
 */
export function shouldUseOfflineInstall(cfg = {}, memTotalMb = null) {
  const mode = String(cfg.offlineInstall ?? 'auto');
  if (mode === 'never') return false;
  if (process.platform !== 'linux') return false;
  if (mode === 'always') return true;
  const maxMb = Number(cfg.offlineInstallMaxMemMb ?? 2560);
  return memTotalMb != null && memTotalMb > 0 && memTotalMb <= maxMb;
}

/**
 * @param {{
 *   unit: string;
 *   npmCmd: string;
 *   version: string;
 *   dshPid: number;
 *   logFile: string;
 *   stateFile: string;
 *   plan: ReturnType<typeof resolveRestartPlan>;
 *   nodeBin: string;
 * }} parts
 */
export function buildOfflineInstallShell(parts) {
  const { unit, npmCmd, version, dshPid, logFile, stateFile, plan, nodeBin } = parts;
  return [
    '#!/bin/bash',
    'set +e',
    `LOG=${shellQuote(logFile)}`,
    `STATE=${shellQuote(stateFile)}`,
    `UNIT=${shellQuote(unit)}`,
    'log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG"; }',
    'write_state_error() {',
    '  node - "$STATE" "$1" <<\'NODE\'',
    'const fs=require("fs");const p=process.argv[2],c=process.argv[3];let o={};try{o=JSON.parse(fs.readFileSync(p,"utf8"))}catch{};Object.assign(o,{status:"error",exitCode:Number(c),finishedAt:new Date().toISOString()});fs.writeFileSync(p,JSON.stringify(o,null,2));',
    'NODE',
    '}',
    'write_state_restart_failed() {',
    '  node - "$STATE" <<\'NODE\'',
    'const fs=require("fs");const p=process.argv[2];let o={};try{o=JSON.parse(fs.readFileSync(p,"utf8"))}catch{};Object.assign(o,{status:"error",exitCode:127,restartFailed:true,finishedAt:new Date().toISOString()});fs.writeFileSync(p,JSON.stringify(o,null,2));',
    'NODE',
    '}',
    'write_state_done() {',
    '  node - "$STATE" <<\'NODE\'',
    'const fs=require("fs");const p=process.argv[2];let o={};try{o=JSON.parse(fs.readFileSync(p,"utf8"))}catch{};Object.assign(o,{status:"done",finishedAt:new Date().toISOString()});fs.writeFileSync(p,JSON.stringify(o,null,2));',
    'NODE',
    '}',
    'unit_loaded_plain() {',
    '  local st',
    '  st=$(systemctl show "$UNIT" -p LoadState --value 2>/dev/null)',
    '  [ "$st" = loaded ] || [ "$st" = embedded ]',
    '}',
    'unit_loaded_sudo() {',
    '  local st',
    '  st=$(sudo -n systemctl show "$UNIT" -p LoadState --value 2>/dev/null)',
    '  [ "$st" = loaded ] || [ "$st" = embedded ]',
    '}',
    'pick_systemctl() {',
    '  if command -v systemctl >/dev/null 2>&1 && unit_loaded_plain; then',
    '    echo plain',
    '    return 0',
    '  fi',
    '  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null && unit_loaded_sudo; then',
    '    echo sudo',
    '    return 0',
    '  fi',
    '  return 1',
    '}',
    'sc_stop() {',
    '  if [ "$SC" = sudo ]; then sudo -n systemctl stop "$UNIT" >>"$LOG" 2>&1; else systemctl stop "$UNIT" >>"$LOG" 2>&1; fi',
    '}',
    'sc_start() {',
    '  if [ "$SC" = sudo ]; then sudo -n systemctl start "$UNIT" >>"$LOG" 2>&1; else systemctl start "$UNIT" >>"$LOG" 2>&1; fi',
    '}',
    'sc_active() {',
    '  if [ "$SC" = sudo ]; then sudo -n systemctl is-active "$UNIT" 2>/dev/null; else systemctl is-active "$UNIT" 2>/dev/null; fi',
    '}',
  `log 'offline install start target=${version} pid=${dshPid} unit=${unit}'`,
    'SC=""',
    'if pick_systemctl >/dev/null 2>&1; then',
    '  SC=$(pick_systemctl)',
    '  log "using $SC for $UNIT"',
    'else',
    '  log "systemd unit not reachable, will kill pid and nohup restart"',
    'fi',
    'if [ -n "$SC" ]; then',
    '  log "$SC stop $UNIT"',
    '  sc_stop',
    '  sleep 2',
    'else',
    `  log "kill dsh pid ${dshPid}"`,
    `  kill -TERM ${dshPid} 2>/dev/null || true`,
    '  sleep 2',
    `  kill -KILL ${dshPid} 2>/dev/null || true`,
    'fi',
    'sleep 2',
    `export PATH=${shellQuote(nodeBin + ':/usr/local/bin:/usr/bin:/bin')}`,
    `log "npm: ${npmCmd.replace(/'/g, "'\\''")}"`,
    `${npmCmd} >>"$LOG" 2>&1`,
    'code=$?',
    'if [ "$code" -ne 0 ]; then',
    '  log "npm FAILED exit=$code"',
    '  write_state_error "$code"',
    '  if [ -n "$SC" ]; then',
    '    log "$SC start $UNIT (after npm failure)"',
    '    sc_start',
    '  fi',
    '  exit "$code"',
    'fi',
    'log "npm OK, starting dsh"',
    'started=0',
    'if [ -n "$SC" ]; then',
    '  log "$SC start $UNIT"',
    '  sc_start',
    '  sleep 3',
    '  active=$(sc_active)',
    '  log "systemd is-active=$active"',
    '  if [ "$active" = active ] || [ "$active" = activating ]; then',
    '    started=1',
    '  fi',
    'fi',
    'if [ "$started" -eq 0 ]; then',
    '  DSH_BIN=$(command -v dsh 2>/dev/null)',
    '  if [ -z "$DSH_BIN" ] && command -v npm >/dev/null 2>&1; then',
    '    prefix=$(npm prefix -g 2>/dev/null)',
    '    [ -n "$prefix" ] && [ -x "$prefix/bin/dsh" ] && DSH_BIN="$prefix/bin/dsh"',
    '  fi',
    '  if [ -n "$DSH_BIN" ]; then',
    `    log "nohup $DSH_BIN web --no-open"`,
    '    nohup "$DSH_BIN" web --no-open >>"$LOG" 2>&1 &',
    '    sleep 3',
    '    started=1',
    '  else',
    `    cd ${shellQuote(plan.cwd)} || true`,
    `    log "nohup ${plan.exe} ${plan.args.join(' ')}"`,
    `    nohup ${shellQuote(plan.exe)} ${plan.args.map(shellQuote).join(' ')} >>"$LOG" 2>&1 &`,
    '    sleep 3',
    '    started=1',
    '  fi',
    'fi',
    'if [ "$started" -eq 0 ]; then',
    '  log "FAILED to restart dsh — try: sudo systemctl start $UNIT"',
    '  write_state_restart_failed',
    '  exit 127',
    'fi',
    'write_state_done',
    'log DONE',
    'exit 0',
  ].join('\n');
}

/**
 * @param {{
 *   pmExe: string;
 *   npmArgv: string[];
 *   version: string;
 *   before?: string | null;
 *   cfg?: Record<string, unknown>;
 *   dshPid?: number;
 * }} opts
 */
export function scheduleOfflineInstall(opts) {
  const stateDir = dshStateDir();
  const logFile = offlineLogFile();
  const stateFile = offlineStateFile();
  const unit = String(opts.cfg?.systemdUnit ?? 'dsh-web.service').trim();
  const plan = resolveRestartPlan();
  const dshPid = opts.dshPid ?? process.pid;
  const npmCmd = opts.npmArgv.map(shellQuote).join(' ');
  const nodeBin = dirname(process.execPath);

  writeOfflineState({
    status: 'running',
    target: opts.version,
    before: opts.before ?? null,
    startedAt: new Date().toISOString(),
    logFile,
    systemdUnit: unit,
  });

  const scriptPath = join(stateDir, `dsh-version-offline-install-${dshPid}.sh`);
  const sh = buildOfflineInstallShell({
    unit,
    npmCmd,
    version: opts.version,
    dshPid,
    logFile,
    stateFile,
    plan,
    nodeBin,
  });

  writeFileSync(scriptPath, sh, { encoding: 'utf8', mode: 0o755 });
  const bash = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
  const child = spawn(bash, [scriptPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  return {
    ok: true,
    offline: true,
    logFile,
    stateFile,
    scriptPath,
    message:
      '小内存离线安装已启动：将先停止 DSH，在后台执行 npm 安装（约 10–30 分钟），完成后自动启动。页面会断开，请稍后刷新或通过 SSH 查看日志。',
  };
}
