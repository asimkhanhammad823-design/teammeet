/**
 * TeamMeet signaling server.
 *
 * The server only relays WebRTC signaling, chat and captions between peers.
 * Audio/video flows peer-to-peer (mesh), so this process uses almost no
 * bandwidth and runs fine on any free tier or a laptop.
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const https = require('https');
const fs = require('fs');
const os = require('os');
const { TunnelManager } = require('./tunnel');

// Optional config.json next to this file: { "NGROK_DOMAIN": "...", "PUBLIC_URL": "...", ... }
// Values act as defaults; real environment variables win.
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  for (const [k, v] of Object.entries(cfg)) if (v !== '' && v != null && process.env[k] === undefined) process.env[k] = String(v);
} catch { /* no config.json – fine */ }

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const MAX_PEERS = parseInt(process.env.MAX_PEERS || '20', 10);

// Public HTTPS URL that team members use: fixed (PUBLIC_URL / Render) or found
// by trying free tunnel providers in turn (TUNNEL=0 disables that).
const tunnel = new TunnelManager({
  port: PORT,
  fixedUrl: process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '',
  enabled: process.env.TUNNEL !== '0',
});

const app = express();
app.disable('x-powered-by');
// Always revalidate so updates reach every browser immediately (files are tiny).
app.use(express.static(path.join(__dirname, 'public'), { etag: true, cacheControl: true, maxAge: 0 }));

// ICE servers. STUN is free from Google. TURN (needed when both sides are behind
// strict NATs) defaults to the free Open Relay project; override with env vars
// if you have your own TURN server.
app.get('/api/ice', (_req, res) => {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  if (process.env.TURN_URLS) {
    iceServers.push({
      urls: process.env.TURN_URLS.split(',').map((s) => s.trim()),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  } else {
    iceServers.push({
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turns:openrelay.metered.ca:443',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    });
  }
  res.json({ iceServers });
});

app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// Client asks this to build the invite links shown in the lobby / meeting.
app.get('/api/config', (_req, res) => {
  res.json({ ...tunnel.snapshot(), lanUrls: lanUrls(), maxPeers: MAX_PEERS });
});

/** Direct HTTPS links for people on the same Wi-Fi / LAN (no internet needed). */
function lanUrls() {
  if (!httpsReady) return [];
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list) {
      if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('169.254.')) out.push(ni.address);
    }
  }
  // Home/office ranges first, VPN/other addresses (e.g. 100.x Tailscale) after.
  const isPrivate = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  out.sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
  return out.map((ip) => `https://${ip}:${HTTPS_PORT}`);
}

/** Self-signed certificate for the LAN HTTPS listener (browsers need a secure context for camera/mic). */
function loadOrCreateCert() {
  const dir = path.join(__dirname, '.cert');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  try {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  } catch { /* regenerate */ }
  let selfsigned;
  try { selfsigned = require('selfsigned'); } catch { return null; }
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) for (const ni of list) if (ni.family === 'IPv4') ips.push(ni.address);
  const altNames = [
    { type: 2, value: 'localhost' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'TeamMeet' }], {
    days: 3650, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames }],
  });
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);
  } catch { /* in-memory only */ }
  return { key: pems.private, cert: pems.cert };
}
let httpsReady = false;

// Pretty room links: https://host/r/my-room
app.get('/r/:room', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 256 * 1024 });

/** @type {Map<string, Map<string, {name:string, joinedAt:number}>>} room -> members */
const rooms = new Map();

// Strip control characters, trim and cap length.
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

/* ------------------------------------------------------------ room helpers */

function getRoom(name) {
  let info = rooms.get(name);
  if (!info) {
    info = { members: new Map(), waiting: new Map(), hostId: null, locked: false, approval: true, startedAt: Date.now() };
    rooms.set(name, info);
  }
  return info;
}

const roomInfo = (info) => ({ hostId: info.hostId, locked: info.locked, approval: info.approval });

function joinPayload(socket, info) {
  const peers = [...info.members].filter(([id]) => id !== socket.id).map(([id, m]) => ({ id, name: m.name }));
  return { id: socket.id, peers, startedAt: info.startedAt, ...roomInfo(info) };
}

/** Add a socket to its room's members and announce it to the others. */
function admit(socket) {
  const room = socket.data.room;
  const info = rooms.get(room);
  if (!info) return;
  info.waiting.delete(socket.id);
  socket.data.waiting = false;
  socket.join(room);
  info.members.set(socket.id, { name: socket.data.name, joinedAt: Date.now() });
  if (!info.hostId) info.hostId = socket.id; // first person in becomes host
  socket.to(room).emit('peer-joined', { id: socket.id, name: socket.data.name });
  console.log(`[join] ${socket.data.name} -> ${room} (${info.members.size} in room)`);
}

function isHost(socket) {
  const info = socket.data.room && rooms.get(socket.data.room);
  return !!info && info.hostId === socket.id;
}

io.on('connection', (socket) => {
  socket.data.room = null;

  socket.on('join', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const r = clean(payload?.room, 48).toLowerCase();
    const name = clean(payload?.name, 40) || 'Guest';
    if (!r) return reply({ error: 'Room code required' });

    if (socket.data.room) leave();

    const info = getRoom(r);
    if (info.members.size + info.waiting.size >= MAX_PEERS) return reply({ error: `Room is full (max ${MAX_PEERS} people)` });
    if (info.locked) return reply({ error: 'This meeting is locked by the host' });

    socket.data.room = r;
    socket.data.name = name;

    // Everyone after the host waits to be admitted (unless the host turned approval off).
    const hostSocket = info.hostId && io.sockets.sockets.get(info.hostId);
    if (info.approval && hostSocket) {
      info.waiting.set(socket.id, { name, since: Date.now() });
      socket.data.waiting = true;
      hostSocket.emit('knock', { id: socket.id, name });
      reply({ waiting: true, id: socket.id, hostName: hostSocket.data.name });
      console.log(`[wait] ${name} waits for host in ${r}`);
      return;
    }
    admit(socket);
    reply({ ok: true, ...joinPayload(socket, info) });
  });

  /* ---------------------------------------------------- host controls */

  // Host lets a waiting person in (or turns them away).
  socket.on('admit', ({ id, allow } = {}) => {
    if (!isHost(socket) || !id) return;
    const info = rooms.get(socket.data.room);
    if (!info.waiting.has(id)) return;
    const target = io.sockets.sockets.get(id);
    if (!target) { info.waiting.delete(id); return; }
    if (allow) {
      admit(target);
      target.emit('admitted', joinPayload(target, info));
    } else {
      info.waiting.delete(id);
      target.emit('denied', { by: socket.data.name });
      target.disconnect(true);
    }
  });

  // Host removes a participant: they are told why, then disconnected.
  socket.on('kick', ({ id } = {}) => {
    if (!isHost(socket) || !id || id === socket.id) return;
    const info = rooms.get(socket.data.room);
    if (!info.members.has(id)) return;
    const target = io.sockets.sockets.get(id);
    console.log(`[kick] ${socket.data.name} removed ${info.members.get(id)?.name} from ${socket.data.room}`);
    if (target) {
      target.emit('kicked', { by: socket.data.name });
      target.disconnect(true); // their disconnect -> leave() -> peer-left for everyone
    } else {
      info.members.delete(id);
    }
  });

  // Host locks/unlocks the room for new joins.
  socket.on('lock', ({ locked } = {}) => {
    if (!isHost(socket)) return;
    const info = rooms.get(socket.data.room);
    info.locked = !!locked;
    io.to(socket.data.room).emit('room-info', roomInfo(info));
  });

  // Host toggles "require approval for new people".
  socket.on('approval', ({ enabled } = {}) => {
    if (!isHost(socket)) return;
    const info = rooms.get(socket.data.room);
    info.approval = !!enabled;
    io.to(socket.data.room).emit('room-info', roomInfo(info));
    if (!info.approval) {
      // Let everyone who is currently waiting straight in.
      for (const id of [...info.waiting.keys()]) {
        const t = io.sockets.sockets.get(id);
        if (!t) { info.waiting.delete(id); continue; }
        admit(t);
        t.emit('admitted', joinPayload(t, info));
      }
    }
  });

  /* --------------------------------------------------------- relaying */

  const inRoom = () => socket.data.room && !socket.data.waiting;

  socket.on('signal', ({ to, data } = {}) => {
    if (!inRoom() || !to || !data) return;
    const info = rooms.get(socket.data.room);
    if (!info?.members.has(to)) return; // only relay inside the room
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('chat', (msg = {}) => {
    if (!inRoom()) return;
    const text = clean(msg.text, 2000);
    if (!text) return;
    io.to(socket.data.room).emit('chat', { from: socket.id, name: socket.data.name, text, ts: Date.now() });
  });

  socket.on('caption', (cap = {}) => {
    if (!inRoom()) return;
    const text = clean(cap.text, 4000);
    if (!text) return;
    socket.to(socket.data.room).emit('caption', { from: socket.id, name: socket.data.name, text, ts: Number(cap.ts) || Date.now() });
  });

  socket.on('state', (s = {}) => {
    if (!inRoom()) return;
    const safe = {};
    for (const k of ['audio', 'video', 'hand', 'screen', 'recording']) {
      if (typeof s[k] === 'boolean') safe[k] = s[k];
    }
    socket.to(socket.data.room).emit('state', { from: socket.id, ...safe });
  });

  function leave() {
    const room = socket.data.room;
    if (!room) return;
    const info = rooms.get(room);
    if (info) {
      if (socket.data.waiting) {
        info.waiting.delete(socket.id);
        const host = info.hostId && io.sockets.sockets.get(info.hostId);
        host?.emit('knock-cancel', { id: socket.id });
      } else {
        info.members.delete(socket.id);
        socket.to(room).emit('peer-left', { id: socket.id, name: socket.data.name });
        // Host left: hand the role to whoever joined next.
        if (info.hostId === socket.id) {
          info.hostId = [...info.members.entries()].sort((a, b) => a[1].joinedAt - b[1].joinedAt)[0]?.[0] || null;
          if (info.hostId) {
            io.to(room).emit('room-info', roomInfo(info));
            // Pending knocks now belong to the new host.
            const newHost = io.sockets.sockets.get(info.hostId);
            for (const [id, w] of info.waiting) newHost?.emit('knock', { id, name: w.name });
          }
        }
        console.log(`[leave] ${socket.data.name} <- ${room}`);
      }
      if (info.members.size === 0 && info.waiting.size === 0) rooms.delete(room);
    }
    socket.leave(room);
    socket.data.room = null;
    socket.data.waiting = false;
  }

  socket.on('leave', leave);
  socket.on('disconnect', leave);
});


server.listen(PORT, () => {
  console.log(`TeamMeet running  ->  http://localhost:${PORT}`);
  tunnel.start();
});

// Second listener: HTTPS on the LAN so teammates on the same Wi-Fi can join
// without any internet tunnel. Shares the same app and Socket.IO instance.
const tls = process.env.NO_HTTPS === '1' ? null : loadOrCreateCert();
if (tls) {
  const httpsServer = https.createServer(tls, app);
  io.attach(httpsServer);
  httpsServer.on('error', (err) => console.log(`[https] disabled: ${err.message}`));
  httpsServer.listen(HTTPS_PORT, () => {
    httpsReady = true;
    for (const u of lanUrls()) console.log(`Same-Wi-Fi link            ->  ${u}`);
  });
}
