/**
 * Public-link manager.
 *
 * Tries free, account-less tunnel providers in order and keeps the first one
 * that yields an HTTPS URL. If a provider fails to produce a URL (blocked DNS,
 * UDP filtered, ...) or its process dies, the next provider is tried. Nothing
 * here is required for LAN use — see the HTTPS server in server.js.
 */
const { spawn } = require('child_process');

const isWin = process.platform === 'win32';

/** Find a binary that winget installed but that may not be on this process's PATH yet. */
function resolveBin(name) {
  if (!isWin) return name;
  const fs = require('fs');
  const path = require('path');
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', `${name}.exe`),
    path.join(process.env.ProgramFiles || '', name, `${name}.exe`),
    path.join(process.env['ProgramFiles(x86)'] || '', name, `${name}.exe`),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // winget package folders: %LOCALAPPDATA%\Microsoft\WinGet\Packages\<Publisher.Name>_…\name.exe
  try {
    const pkgs = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    for (const dir of fs.readdirSync(pkgs)) {
      const exe = path.join(pkgs, dir, `${name}.exe`);
      if (dir.toLowerCase().includes(name) && fs.existsSync(exe)) return exe;
    }
  } catch { /* no winget packages dir */ }
  return name; // rely on PATH
}

function providers(port) {
  const list = [];
  // ngrok with a reserved free domain: the address never changes across
  // reconnects/restarts. Needs `ngrok config add-authtoken …` run once by the user.
  if (process.env.NGROK_DOMAIN) {
    list.push({
      name: 'ngrok',
      cmd: resolveBin('ngrok'),
      args: ['http', String(port), '--domain', process.env.NGROK_DOMAIN, '--log', 'stdout', '--log-format', 'logfmt'],
      re: new RegExp(`https://${process.env.NGROK_DOMAIN.replace(/\./g, '\\.')}`, 'i'),
      install: 'winget install ngrok.ngrok',
    });
  }
  return list.concat([
    {
      name: 'cloudflare',
      cmd: resolveBin('cloudflared'),
      // http2 instead of QUIC (UDP is often filtered), IPv4 edge only.
      args: ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4'],
      // Quick-tunnel hosts look like word-word-word-word.trycloudflare.com
      re: /https:\/\/(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/i,
      install: 'winget install Cloudflare.cloudflared',
    },
    {
      name: 'localhost.run',
      cmd: 'ssh',
      args: [
        '-T', '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${isWin ? 'NUL' : '/dev/null'}`,
        '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes',
        '-R', `80:localhost:${port}`, 'nokey@localhost.run',
      ],
      re: /https:\/\/[a-z0-9-]+\.lhr\.life/i,
      install: 'Windows: Settings > Apps > Optional features > OpenSSH Client',
    },
    {
      name: 'serveo',
      cmd: 'ssh',
      args: [
        '-T', '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${isWin ? 'NUL' : '/dev/null'}`,
        '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes',
        '-R', `80:localhost:${port}`, 'serveo.net',
      ],
      re: /https:\/\/[a-z0-9-]+\.serveo\.net/i,
      install: '',
    },
  ]);
}

class TunnelManager {
  /**
   * @param {object} o
   * @param {number|string} o.port
   * @param {string} [o.fixedUrl]  PUBLIC_URL / RENDER_EXTERNAL_URL – disables tunnelling.
   * @param {boolean} [o.enabled]
   * @param {(msg:string)=>void} [o.log]
   */
  constructor({ port, fixedUrl = '', enabled = true, log = console.log }) {
    this.port = port;
    this.log = log;
    this.enabled = enabled && !fixedUrl;
    this.url = fixedUrl;
    this.provider = fixedUrl ? 'fixed' : '';
    this.status = fixedUrl ? 'ready' : enabled ? 'starting' : 'off';
    this.error = '';
    this.providers = providers(port);
    this.index = 0;
    this.roundsFailed = 0;
    this.proc = null;
    this.startTimer = null;
    process.on('exit', () => this.proc?.kill());
  }

  start() {
    if (!this.enabled) return;
    this._launch();
  }

  snapshot() {
    return { publicUrl: this.url, tunnelStatus: this.status, tunnelProvider: this.provider, tunnelError: this.error };
  }

  _launch() {
    const p = this.providers[this.index];
    if (!p) {
      // Every provider failed this round: back off, then start over.
      this.roundsFailed += 1;
      this.index = 0;
      this.status = 'failed';
      const delay = Math.min(30_000 * this.roundsFailed, 120_000);
      this.log(`[tunnel] all providers failed (round ${this.roundsFailed}); retrying in ${delay / 1000}s`);
      setTimeout(() => this._launch(), delay);
      return;
    }

    if (this.roundsFailed === 0) this.status = 'starting';
    this.provider = p.name;
    this.log(`[tunnel] trying ${p.name}…`);

    let gotUrl = false;
    let proc;
    try {
      proc = spawn(p.cmd, p.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return this._next(`${p.cmd}: ${err.message}`);
    }
    this.proc = proc;

    // A provider that produces nothing within 45 s is considered blocked.
    this.startTimer = setTimeout(() => {
      if (!gotUrl) { this.log(`[tunnel] ${p.name} timed out`); proc.kill(); }
    }, 45_000);

    const onData = (buf) => {
      const text = String(buf);
      const m = text.match(p.re);
      if (m && !gotUrl) {
        gotUrl = true;
        clearTimeout(this.startTimer);
        this.url = m[0];
        this.status = 'ready';
        this.error = '';
        this.roundsFailed = 0;
        this.log(`\n  Public link (${p.name})  ->  ${this.url}\n`);
      } else if (/error|failed|denied|timeout|timed out/i.test(text)) {
        this.error = text.trim().split('\n').pop().slice(0, 200);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('error', (err) => {
      clearTimeout(this.startTimer);
      const hint = err.code === 'ENOENT' ? ` (not installed${p.install ? ` — ${p.install}` : ''})` : '';
      this._next(`${p.cmd} unavailable${hint}`);
    });

    proc.on('exit', (code) => {
      clearTimeout(this.startTimer);
      if (this.proc !== proc) return;
      this.proc = null;
      if (gotUrl) {
        // A live tunnel dropped – restart the same provider quickly.
        this.url = '';
        this.status = 'starting';
        this.log(`[tunnel] ${p.name} disconnected (code ${code}); reconnecting in 3s`);
        setTimeout(() => this._launch(), 3000);
      } else {
        this._next(`${p.name} exited (${code})${this.error ? `: ${this.error}` : ''}`);
      }
    });
  }

  _next(reason) {
    this.log(`[tunnel] ${reason}`);
    this.url = '';
    this.index += 1;
    setTimeout(() => this._launch(), 1500);
  }
}

module.exports = { TunnelManager };
