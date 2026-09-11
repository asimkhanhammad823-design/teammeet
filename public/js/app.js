import { Mesh } from './rtc.js';
import { MeetingRecorder, initials, fmtDuration, fmtBytes } from './recorder.js';
import { Transcriber, TranscriptLog, LANGUAGES, download, clock } from './transcript.js';

/* global io */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const COLORS = ['#4f8cff', '#8b5cf6', '#ec4899', '#f97316', '#22c55e', '#14b8a6', '#eab308', '#ef4444'];
const colorFor = (id) => COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

const QUALITY = {
  540: { width: 960, height: 540, bitrate: 1_400_000 },
  720: { width: 1280, height: 720, bitrate: 2_500_000 },
  1080: { width: 1920, height: 1080, bitrate: 4_500_000 },
};

const state = {
  name: '',
  room: '',
  myId: null,
  socket: null,
  mesh: null,
  local: null,            // MediaStream sent to peers (mic + camera/screen)
  camTrack: null,
  micTrack: null,
  screenTrack: null,
  audioCtx: null,
  recorder: null,
  transcriber: null,
  log: null,
  startedAt: 0,
  muted: false,
  camOff: false,
  hand: false,
  ccOn: false,
  lang: localStorage.getItem('tm.lang') || 'en-US',
  quality: localStorage.getItem('tm.quality') || '720',
  /** @type {Map<string, PeerUI>} */
  peers: new Map(),
  meters: new Map(),
  unread: 0,
  sideTab: null,
};

/* =============================================================== LOBBY */

const lobby = {
  preview: $('#preview'),
  stream: null,
};

async function initLobby() {
  $('#name').value = localStorage.getItem('tm.name') || '';
  const roomFromUrl = location.pathname.match(/^\/r\/([^/]+)/)?.[1] || new URLSearchParams(location.search).get('room');
  $('#room').value = roomFromUrl ? decodeURIComponent(roomFromUrl) : localStorage.getItem('tm.room') || genRoom();

  const langSel = $('#selLang');
  for (const [code, label] of LANGUAGES) langSel.add(new Option(label, code));
  langSel.value = state.lang;
  $('#selQuality').value = state.quality;

  $('#btnNewRoom').onclick = () => { $('#room').value = genRoom(); updateInvite(); };
  $('#room').addEventListener('input', updateInvite);
  $('#btnInviteCopy').onclick = async () => {
    const ok = await copyText(inviteUrl());
    toast(ok ? 'Invite link copied — send it to your team' : 'Copy failed, select the link and copy manually', ok ? 'success' : 'warn');
  };
  $('#btnLanCopy').onclick = async () => {
    const ok = await copyText($('#lanLink').textContent);
    toast(ok ? 'Wi‑Fi link copied. Teammates accept the browser’s certificate warning once (Advanced → Proceed).' : 'Copy failed', ok ? 'success' : 'warn', 7000);
  };
  updateInvite();
  pollConfig();
  $('#selMic').onchange = $('#selCam').onchange = () => startPreview();
  $('#pvMic').onclick = () => { state.muted = !state.muted; $('#pvMic').classList.toggle('is-off', state.muted); applyPreviewToggles(); };
  $('#pvCam').onclick = () => { state.camOff = !state.camOff; $('#pvCam').classList.toggle('is-off', state.camOff); applyPreviewToggles(); };
  $('#btnJoin').onclick = join;
  $('#room').addEventListener('keydown', (e) => e.key === 'Enter' && join());
  $('#name').addEventListener('keydown', (e) => e.key === 'Enter' && join());

  if (!navigator.mediaDevices?.getUserMedia) {
    showLobbyError('This browser cannot access camera/microphone. Open the page over https:// or on localhost.');
    return;
  }
  await startPreview();
  navigator.mediaDevices.addEventListener('devicechange', () => listDevices());
}

function applyPreviewToggles() {
  lobby.stream?.getAudioTracks().forEach((t) => (t.enabled = !state.muted));
  lobby.stream?.getVideoTracks().forEach((t) => (t.enabled = !state.camOff));
  $('#previewOff').classList.toggle('hidden', !state.camOff && !!lobby.stream?.getVideoTracks().length);
}

async function startPreview() {
  lobby.stream?.getTracks().forEach((t) => t.stop());
  lobby.stream = null;
  const micId = $('#selMic').value;
  const camId = $('#selCam').value;
  const constraints = {
    audio: {
      deviceId: micId ? { exact: micId } : undefined,
      echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
    },
    video: {
      deviceId: camId ? { exact: camId } : undefined,
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 },
    },
  };
  try {
    lobby.stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // Retry audio-only (no camera / camera busy).
    try {
      lobby.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints.audio });
      toast('Camera unavailable — joining with microphone only.', 'warn');
    } catch (err2) {
      showLobbyError(`Could not access microphone/camera: ${err2.message}`);
      return;
    }
  }
  hideLobbyError();
  lobby.preview.srcObject = lobby.stream;
  applyPreviewToggles();
  await listDevices();
}

async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, current) => {
    const value = current || sel.value;
    sel.innerHTML = '';
    devices.filter((d) => d.kind === kind).forEach((d, i) => sel.add(new Option(d.label || `${kind === 'audioinput' ? 'Microphone' : 'Camera'} ${i + 1}`, d.deviceId)));
    if ([...sel.options].some((o) => o.value === value)) sel.value = value;
  };
  fill($('#selMic'), 'audioinput', lobby.stream?.getAudioTracks()[0]?.getSettings().deviceId);
  fill($('#selCam'), 'videoinput', lobby.stream?.getVideoTracks()[0]?.getSettings().deviceId);
}

function showLobbyError(msg) { const el = $('#lobbyError'); el.textContent = msg; el.classList.remove('hidden'); }
function hideLobbyError() { $('#lobbyError').classList.add('hidden'); }

/* ------------------------------------------------------- invite link */

function currentRoom() {
  return ($('#room').value || state.room || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function inviteUrl() {
  const base = state.publicUrl || location.origin;
  return `${base}/r/${encodeURIComponent(currentRoom() || 'room')}`;
}

const isLocalOrigin = () => /^https?:\/\/(localhost|127\.|\[::1\])/.test(location.origin);

function updateInvite() {
  const url = inviteUrl();
  $('#inviteLink').value = url;
  $('#btnInviteWa').href = `https://wa.me/?text=${encodeURIComponent(`Join our meeting: ${url}`)}`;

  const st = $('#inviteStatus');
  const hint = $('#inviteHint');
  const provider = state.tunnelProvider && state.tunnelProvider !== 'fixed' ? ` via ${state.tunnelProvider}` : '';
  hint.classList.add('hidden');

  if (state.publicUrl) { st.textContent = `public link ready${provider}`; st.className = 'ok'; }
  else if (!isLocalOrigin()) { st.textContent = 'ready'; st.className = 'ok'; }
  else if (state.tunnelStatus === 'failed') {
    st.textContent = 'internet link unavailable — retrying';
    st.className = 'warn';
    hint.textContent = 'Your connection is blocking the free tunnel services right now. The server keeps retrying automatically. People on the same Wi‑Fi can use the link below; for a permanent link see README (Render).';
    hint.classList.remove('hidden');
  } else if (state.tunnelStatus === 'off') { st.textContent = 'tunnel disabled'; st.className = 'warn'; }
  else { st.textContent = `getting public link…${state.tunnelProvider ? ` (${state.tunnelProvider})` : ''}`; st.className = ''; }

  // Same-Wi-Fi link (self-signed HTTPS; browsers show a one-time warning).
  const lan = (state.lanUrls || [])[0];
  const lanRow = $('#lanRow');
  if (lan && isLocalOrigin()) {
    lanRow.classList.remove('hidden');
    $('#lanLink').textContent = `${lan}/r/${encodeURIComponent(currentRoom() || 'room')}`;
  } else lanRow.classList.add('hidden');
}

async function pollConfig() {
  try {
    const cfg = await (await fetch('/api/config', { cache: 'no-store' })).json();
    state.tunnelStatus = cfg.tunnelStatus;
    state.tunnelProvider = cfg.tunnelProvider || '';
    state.maxPeers = cfg.maxPeers;
    state.lanUrls = cfg.lanUrls || [];
    // Already on the public/LAN host? Prefer the address bar (custom domains etc.)
    state.publicUrl = isLocalOrigin() ? cfg.publicUrl || '' : location.origin;
  } catch { /* server unreachable; retry */ }
  updateInvite();
  // Keep polling while in the lobby so a dropped/recovered tunnel is reflected.
  if ($('#lobby').classList.contains('hidden')) return;
  setTimeout(pollConfig, state.publicUrl || state.tunnelStatus === 'off' ? 15000 : 3000);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const el = $('#inviteLink');
    el.value = text; el.select();
    try { return document.execCommand('copy'); } catch { return false; }
  }
}

function genRoom() {
  const w = () => Array.from({ length: 3 }, () => 'abcdefghijkmnpqrstuvwxyz'[Math.floor(Math.random() * 24)]).join('');
  return `${w()}-${w()}${w().slice(0, 1)}-${w()}`;
}

/* ================================================================ JOIN */

async function join() {
  const name = $('#name').value.trim();
  const room = $('#room').value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!name) return showLobbyError('Please enter your name.');
  if (!room) return showLobbyError('Please enter a room code.');
  if (!lobby.stream) return showLobbyError('Microphone access is required to join.');

  state.name = name;
  state.room = room;
  state.lang = $('#selLang').value;
  state.quality = $('#selQuality').value;
  localStorage.setItem('tm.name', name);
  localStorage.setItem('tm.room', room);
  localStorage.setItem('tm.lang', state.lang);
  localStorage.setItem('tm.quality', state.quality);

  $('#btnJoin').disabled = true;
  $('#btnJoin').textContent = 'Connecting…';

  state.local = lobby.stream;
  state.micTrack = state.local.getAudioTracks()[0] || null;
  state.camTrack = state.local.getVideoTracks()[0] || null;
  if (!state.camTrack) state.camOff = true;

  state.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  await state.audioCtx.resume();

  let ice = [];
  try { ice = (await (await fetch('/api/ice')).json()).iceServers; } catch { /* STUN-less fallback */ }

  state.socket = io({ transports: ['websocket', 'polling'] });
  state.socket.on('connect', () => onConnected(ice));
  state.socket.on('connect_error', (e) => showLobbyError(`Cannot reach server: ${e.message}`));
  state.socket.on('disconnect', () => { if ($('#meeting').classList.contains('hidden')) return; toast('Connection lost — reconnecting…', 'warn'); });
  state.socket.on('peer-joined', onPeerJoined);
  state.socket.on('peer-left', onPeerLeft);
  state.socket.on('signal', ({ from, data }) => state.mesh?.handleSignal(from, data));
  state.socket.on('chat', onChat);
  state.socket.on('caption', onCaption);
  state.socket.on('state', onPeerState);
}

function onConnected(iceServers) {
  const rejoin = !!state.mesh;
  if (rejoin) {
    // Reconnected with a new socket id: rebuild all peer connections.
    state.mesh.close();
    for (const id of [...state.peers.keys()]) if (id !== 'me') removePeerUI(id);
  }
  state.socket.emit('join', { room: state.room, name: state.name }, (res) => {
    if (res.error) {
      showLobbyError(res.error);
      $('#btnJoin').disabled = false;
      $('#btnJoin').textContent = 'Join meeting';
      state.socket.disconnect();
      return;
    }
    state.myId = res.id;
    state.startedAt = state.startedAt || res.startedAt;
    state.mesh = new Mesh({
      socket: state.socket,
      myId: state.myId,
      iceServers,
      localStream: state.local,
      maxVideoBitrate: QUALITY[state.quality].bitrate,
      onStream: onRemoteStream,
      onPeerLeft: removePeerUI,
      onConnection: (id, s) => state.peers.get(id)?.tile.classList.toggle('connecting', s !== 'connected'),
    });
    for (const p of res.peers) {
      addPeerUI(p.id, p.name);
      state.mesh.addPeer(p.id, p.name);
    }
    if (!rejoin) enterMeeting();
    else toast('Reconnected', 'success');
    broadcastState();
  });
}

function enterMeeting() {
  $('#lobby').classList.add('hidden');
  $('#meeting').classList.remove('hidden');
  history.replaceState(null, '', `/r/${encodeURIComponent(state.room)}`);
  $('#roomTitle').textContent = state.room;
  document.title = `${state.room} · TeamMeet`;

  state.log = new TranscriptLog({ storageKey: `tm.transcript.${state.room}`, meetingStart: state.startedAt });
  renderTranscript();

  addPeerUI('me', state.name, true);
  const me = state.peers.get('me');
  me.tile.querySelector('video').srcObject = state.local;
  attachMeter('me', state.local);
  updateTile('me', { audio: !state.muted, video: !state.camOff });

  $('#btnMic').classList.toggle('is-off', state.muted);
  $('#btnCam').classList.toggle('is-off', state.camOff);

  setInterval(tick, 1000);
  setInterval(pollMeters, 150);
  initControls();
  renderPeople();
  relayout();
  sysMsg(`You joined "${state.room}"`);
  if (!Transcriber.supported()) toast('Live transcript needs Chrome or Edge. Others’ captions will still appear here.', 'warn', 8000);
  if (!window.showSaveFilePicker) toast('For multi-hour recordings use Chrome/Edge (direct-to-disk saving).', 'warn', 8000);
}

/* ============================================================ PEERS UI */

/** @typedef {{name:string, tile:HTMLElement, stream?:MediaStream, audio:boolean, video:boolean, hand:boolean, screen:boolean, recording:boolean, speaking:boolean}} PeerUI */

function addPeerUI(id, name, isLocal = false) {
  if (state.peers.has(id)) { state.peers.get(id).name = name; return state.peers.get(id); }
  const tile = document.createElement('div');
  tile.className = `tile${isLocal ? ' local' : ''} connecting`;
  tile.dataset.id = id;
  tile.innerHTML = `
    <video autoplay playsinline ${isLocal ? 'muted' : ''}></video>
    <div class="avatar"><span style="background:${colorFor(id === 'me' ? state.name : id)}">${initials(name)}</span></div>
    <div class="hand">✋</div>
    <div class="conn">connecting…</div>
    <div class="label"><svg><use href="#i-mic-off"/></svg><span>${escapeHtml(name)}${isLocal ? ' (you)' : ''}</span></div>`;
  if (isLocal) tile.classList.remove('connecting');
  $('#grid').appendChild(tile);
  const ui = { name, tile, audio: true, video: true, hand: false, screen: false, recording: false, speaking: false };
  state.peers.set(id, ui);
  relayout();
  renderPeople();
  return ui;
}

function removePeerUI(id) {
  const p = state.peers.get(id);
  if (!p) return;
  p.tile.remove();
  state.peers.delete(id);
  state.meters.delete(id);
  state.recorder?.removeAudio(id);
  relayout();
  renderPeople();
}

function onRemoteStream(id, stream) {
  const p = state.peers.get(id) || addPeerUI(id, state.mesh.peers.get(id)?.name || 'Guest');
  p.stream = stream;
  const v = p.tile.querySelector('video');
  if (v.srcObject !== stream) {
    v.srcObject = stream;
    v.play().catch(() => {});
    attachMeter(id, stream);
    state.recorder?.addAudio(id, stream);
  }
}

function onPeerJoined({ id, name }) {
  addPeerUI(id, name);
  state.mesh.addPeer(id, name);
  state.mesh.setName(id, name);
  sysMsg(`${name} joined`);
  toast(`${name} joined`, 'info', 2500);
  broadcastState();
}

function onPeerLeft({ id, name }) {
  state.mesh?.removePeer(id);
  removePeerUI(id);
  sysMsg(`${name || 'Someone'} left`);
}

function onPeerState({ from, ...s }) {
  const p = state.peers.get(from);
  if (!p) return;
  if (s.recording === true && !p.recording) toast(`${p.name} started recording`, 'warn');
  if (s.recording === false && p.recording) toast(`${p.name} stopped recording`, 'info');
  updateTile(from, s);
}

function updateTile(id, s) {
  const p = state.peers.get(id);
  if (!p) return;
  Object.assign(p, Object.fromEntries(Object.entries(s).filter(([k]) => ['audio', 'video', 'hand', 'screen', 'recording'].includes(k))));
  p.tile.classList.toggle('muted', !p.audio);
  p.tile.classList.toggle('cam-off', !p.video && !p.screen);
  p.tile.classList.toggle('hand-up', p.hand);
  p.tile.classList.toggle('screen', p.screen);
  relayout();
  renderPeople();
}

function broadcastState() {
  state.socket?.emit('state', {
    audio: !state.muted,
    video: !state.camOff,
    hand: state.hand,
    screen: !!state.screenTrack,
    recording: !!state.recorder?.active,
  });
}

function relayout() {
  const grid = $('#grid');
  const tiles = [...state.peers.values()];
  const screen = tiles.find((p) => p.screen);
  grid.classList.toggle('spotlight', !!screen && tiles.length > 1);
  grid.classList.toggle('solo', tiles.length === 1);
  const n = Math.max(1, tiles.length);
  grid.style.setProperty('--cols', screen ? 1 : Math.ceil(Math.sqrt(n)));
  grid.style.setProperty('--rows', Math.max(1, tiles.length - 1));
  // keep local tile first, screen share first when spotlighting
  if (screen) grid.prepend(screen.tile);
  $('#peopleCount').textContent = tiles.length;
}

function renderPeople() {
  const ul = $('#peopleList');
  ul.innerHTML = '';
  for (const [id, p] of state.peers) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="av" style="background:${colorFor(id === 'me' ? state.name : id)}">${initials(p.name)}</span>
      <span class="pn">${escapeHtml(p.name)}${id === 'me' ? '<small>you</small>' : ''}</span>
      <span class="st">
        ${p.hand ? '✋' : ''}
        ${p.recording ? '<svg class="rec"><use href="#i-record"/></svg>' : ''}
        ${p.screen ? '<svg><use href="#i-screen"/></svg>' : ''}
        <svg class="${p.audio ? '' : 'off'}"><use href="#${p.audio ? 'i-mic' : 'i-mic-off'}"/></svg>
        <svg class="${p.video ? '' : 'off'}"><use href="#${p.video ? 'i-video' : 'i-video-off'}"/></svg>
      </span>`;
    ul.appendChild(li);
  }
}

/* ------------------------------------------------------- speaking meter */

function attachMeter(id, stream) {
  const tracks = stream.getAudioTracks();
  if (!tracks.length) return;
  try {
    const src = state.audioCtx.createMediaStreamSource(new MediaStream(tracks));
    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    state.meters.set(id, { analyser, buf: new Uint8Array(analyser.fftSize), hold: 0 });
  } catch { /* noop */ }
}

function pollMeters() {
  for (const [id, m] of state.meters) {
    const p = state.peers.get(id);
    if (!p) continue;
    m.analyser.getByteTimeDomainData(m.buf);
    let sum = 0;
    for (let i = 0; i < m.buf.length; i++) { const d = (m.buf[i] - 128) / 128; sum += d * d; }
    const rms = Math.sqrt(sum / m.buf.length);
    const loud = rms > 0.04 && p.audio;
    m.hold = loud ? 4 : Math.max(0, m.hold - 1);
    const speaking = m.hold > 0;
    if (speaking !== p.speaking) { p.speaking = speaking; p.tile.classList.toggle('speaking', speaking); }
  }
}

/* ============================================================= CONTROLS */

function initControls() {
  $('#btnMic').onclick = toggleMic;
  $('#btnCam').onclick = toggleCam;
  $('#btnScreen').onclick = toggleScreen;
  $('#btnRecord').onclick = toggleRecord;
  $('#btnCC').onclick = toggleCC;
  $('#btnHand').onclick = () => { state.hand = !state.hand; $('#btnHand').classList.toggle('is-on', state.hand); updateTile('me', { hand: state.hand }); broadcastState(); };
  $('#btnLeave').onclick = leave;
  $('#btnCopy').onclick = copyLink;
  $$('[data-open]').forEach((b) => (b.onclick = () => toggleSide(b.dataset.open)));
  $$('.tabs [data-tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  $('#btnCloseSide').onclick = () => toggleSide(null);

  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#chatInput').value.trim();
    if (!text) return;
    state.socket.emit('chat', { text });
    $('#chatInput').value = '';
  };

  const trLang = $('#trLang');
  for (const [code, label] of LANGUAGES) trLang.add(new Option(label, code));
  trLang.value = state.lang;
  trLang.onchange = () => { state.lang = trLang.value; localStorage.setItem('tm.lang', state.lang); state.transcriber?.setLang(state.lang); };
  $('#trTxt').onclick = () => exportTranscript('txt');
  $('#trSrt').onclick = () => exportTranscript('srt');
  $('#trJson').onclick = () => exportTranscript('json');
  $('#trCopy').onclick = async () => { await navigator.clipboard.writeText(state.log.toTXT(`Transcript — ${state.room}`)); toast('Transcript copied', 'success'); };
  $('#trClear').onclick = () => { if (confirm('Clear the transcript on this device?')) { state.log.clear(); renderTranscript(); } };

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'm') toggleMic();
    else if (k === 'v') toggleCam();
    else if (k === 's') toggleScreen();
    else if (k === 'r') toggleRecord();
    else if (k === 'c') toggleCC();
    else if (k === 'h') $('#btnHand').click();
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.recorder?.active) { e.preventDefault(); e.returnValue = ''; }
  });
}

function toggleMic() {
  state.muted = !state.muted;
  if (state.micTrack) state.micTrack.enabled = !state.muted;
  $('#btnMic').classList.toggle('is-off', state.muted);
  updateTile('me', { audio: !state.muted });
  broadcastState();
  // Speech recognition opens its own mic capture – pause it while muted.
  if (state.ccOn) state.muted ? state.transcriber?.stop() : state.transcriber?.start();
}

function toggleCam() {
  if (!state.camTrack) return toast('No camera available', 'warn');
  state.camOff = !state.camOff;
  state.camTrack.enabled = !state.camOff;
  $('#btnCam').classList.toggle('is-off', state.camOff);
  updateTile('me', { video: !state.camOff });
  broadcastState();
}

async function toggleScreen() {
  if (state.screenTrack) return stopScreen();
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: false,
    });
  } catch { return; }
  const track = display.getVideoTracks()[0];
  track.contentHint = 'detail';
  state.screenTrack = track;
  await state.mesh.replaceTrack('video', track);
  const me = state.peers.get('me');
  me.tile.querySelector('video').srcObject = new MediaStream([track]);
  updateTile('me', { screen: true });
  $('#btnScreen').classList.add('is-on');
  track.onended = stopScreen;
  broadcastState();
}

async function stopScreen() {
  const track = state.screenTrack;
  if (!track) return;
  state.screenTrack = null;
  track.onended = null;
  track.stop();
  await state.mesh.replaceTrack('video', state.camTrack);
  const me = state.peers.get('me');
  me.tile.querySelector('video').srcObject = state.local;
  updateTile('me', { screen: false });
  $('#btnScreen').classList.remove('is-on');
  broadcastState();
}

/* ------------------------------------------------------------ recording */

async function toggleRecord() {
  if (state.recorder?.active) return stopRecording();
  if (!MeetingRecorder.supported()) return toast('Recording is not supported in this browser. Use Chrome or Edge.', 'error');

  const q = QUALITY[state.quality];
  const rec = new MeetingRecorder({
    audioCtx: state.audioCtx,
    getTiles: tilesForRecorder,
    width: q.width, height: q.height, fps: 30, videoBitrate: q.bitrate,
    onError: (err) => { toast(`Recording error: ${err.message || err}`, 'error', 10000); stopRecording(); },
  });
  // Mix everyone's audio (own mic straight from the track, others from their streams).
  if (state.micTrack) rec.addAudio('me', new MediaStream([state.micTrack]));
  for (const [id, p] of state.peers) if (id !== 'me' && p.stream) rec.addAudio(id, p.stream);

  const fileName = `meeting-${state.room}-${stamp()}.webm`;
  try {
    const { mode } = await rec.start({ fileName });
    state.recorder = rec;
    $('#btnRecord').classList.add('is-rec');
    $('#recBadge').classList.remove('hidden');
    toast(mode === 'fs' ? 'Recording — saving directly to disk. Keep this window open.' : 'Recording (in-memory mode). Keep this tab open.', 'success', 6000);
    sysMsg('You started recording');
    broadcastState();
  } catch (err) {
    if (err?.name !== 'AbortError') toast(`Could not start recording: ${err.message}`, 'error');
  }
}

async function stopRecording() {
  const rec = state.recorder;
  if (!rec) return;
  state.recorder = null;
  $('#btnRecord').classList.remove('is-rec');
  $('#recBadge').classList.add('hidden');
  broadcastState();
  const duration = fmtDuration(rec.elapsed);
  let result;
  try { result = await rec.stop(); } catch (err) { return toast(`Failed to finalise recording: ${err.message}`, 'error', 10000); }
  if (!result) return;

  if (result.mode === 'fs') {
    toast(`Recording saved: <b>${escapeHtml(result.name)}</b> (${duration}, ${fmtBytes(rec.bytes)})`, 'success', 12000);
  } else {
    download(result.name, await (await fetch(result.url)).blob(), 'video/webm');
    toast(`Recording downloaded: <b>${escapeHtml(result.name)}</b> (${duration}, ${fmtBytes(result.size)})`, 'success', 12000);
  }
  sysMsg(`Recording stopped (${duration})`);
  if (!state.log.isEmpty) {
    exportTranscript('txt');
    toast('Transcript (.txt) downloaded alongside the recording. SRT/JSON are in the Transcript panel.', 'info', 8000);
  }
}

function tilesForRecorder() {
  const out = [];
  for (const [id, p] of state.peers) {
    out.push({
      video: p.tile.querySelector('video'),
      name: p.name,
      muted: !p.audio,
      camOff: !p.video && !p.screen,
      isScreen: p.screen,
      speaking: p.speaking,
      color: colorFor(id === 'me' ? state.name : id),
    });
  }
  // screen share first so the recorder spotlights it
  out.sort((a, b) => (b.isScreen ? 1 : 0) - (a.isScreen ? 1 : 0));
  return out;
}

/* ----------------------------------------------------------- transcript */

function toggleCC() {
  if (!Transcriber.supported()) return toast('Live transcript needs Chrome or Edge.', 'error');
  state.ccOn = !state.ccOn;
  $('#btnCC').classList.toggle('is-on', state.ccOn);
  if (state.ccOn) {
    if (!state.transcriber) {
      state.transcriber = new Transcriber({
        lang: state.lang,
        onInterim: (text) => showCaption({ name: state.name, text, interim: true }),
        onFinal: (text) => {
          const entry = { from: 'me', name: state.name, text, ts: Date.now() };
          state.log.add(entry);
          appendTranscript(entry);
          showCaption(entry);
          state.socket.emit('caption', { text, ts: entry.ts });
        },
        onStatus: (s, detail) => {
          const el = $('#trStatus');
          el.className = `tr-status ${s === 'listening' ? 'on' : s === 'denied' || s === 'error' ? 'err' : ''}`;
          el.textContent = s === 'listening' ? '● listening' : s === 'denied' ? 'mic blocked' : s === 'error' ? `error: ${detail}` : 'off';
          if (s === 'denied') { state.ccOn = false; $('#btnCC').classList.remove('is-on'); toast('Speech recognition was blocked. Allow microphone for this site.', 'error'); }
        },
      });
    }
    if (!state.muted) state.transcriber.start();
    else $('#trStatus').textContent = 'paused (muted)';
    toast('Live transcript on — your speech is transcribed and shared with the room.', 'success', 4000);
  } else {
    state.transcriber?.stop();
    $('#trStatus').className = 'tr-status';
    $('#trStatus').textContent = 'off';
  }
}

function onCaption({ from, name, text, ts }) {
  const entry = { from, name, text, ts };
  state.log.add(entry);
  appendTranscript(entry);
  showCaption(entry);
}

let captionTimer;
function showCaption({ name, text, interim }) {
  const box = $('#captions');
  let interimEl = box.querySelector('.interim');
  if (interim) {
    if (!text) { interimEl?.remove(); return; }
    if (!interimEl) { interimEl = document.createElement('div'); interimEl.className = 'interim'; box.appendChild(interimEl); }
    interimEl.innerHTML = `<b>${escapeHtml(name)}</b>${escapeHtml(text)}`;
    return;
  }
  const el = document.createElement('div');
  el.innerHTML = `<b>${escapeHtml(name)}</b>${escapeHtml(text)}`;
  box.insertBefore(el, interimEl);
  while (box.querySelectorAll('div:not(.interim)').length > 2) box.querySelector('div:not(.interim)').remove();
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => box.querySelectorAll('div:not(.interim)').forEach((d) => d.remove()), 7000);
}

function renderTranscript() {
  const list = $('#trList');
  list.innerHTML = '';
  if (state.log.isEmpty) {
    list.innerHTML = '<div class="empty">No transcript yet.<br>Turn on <b>CC</b> to transcribe your own speech; everyone who does so is added here with their name.</div>';
    return;
  }
  for (const e of state.log.entries) appendTranscript(e, false);
}

function appendTranscript(e, scroll = true) {
  const list = $('#trList');
  list.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = 'e';
  el.innerHTML = `<time>${clock(e.ts - state.startedAt)}</time><b>${escapeHtml(e.name)}:</b> ${escapeHtml(e.text)}`;
  list.appendChild(el);
  if (scroll) list.scrollTop = list.scrollHeight;
}

function exportTranscript(fmt) {
  if (state.log.isEmpty) return toast('Transcript is empty', 'warn');
  const base = `transcript-${state.room}-${stamp()}`;
  if (fmt === 'txt') download(`${base}.txt`, state.log.toTXT(`Transcript — ${state.room}`));
  if (fmt === 'srt') download(`${base}.srt`, state.log.toSRT(), 'application/x-subrip');
  if (fmt === 'json') download(`${base}.json`, state.log.toJSON(), 'application/json');
}

/* ----------------------------------------------------------------- chat */

function onChat({ from, name, text, ts }) {
  const me = from === state.myId;
  const el = document.createElement('div');
  el.className = `msg${me ? ' me' : ''}`;
  el.innerHTML = `<div class="meta">${me ? 'You' : escapeHtml(name)} · ${new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div><div class="bubble">${linkify(text)}</div>`;
  pushChat(el);
  if (!me && state.sideTab !== 'chat') {
    state.unread++;
    $('#chatUnread').textContent = state.unread;
    $('#chatUnread').classList.remove('hidden');
    $('#chatDot').classList.remove('hidden');
  }
}

function sysMsg(text) {
  const el = document.createElement('div');
  el.className = 'msg sys';
  el.textContent = text;
  pushChat(el);
}

function pushChat(el) {
  const list = $('#chatList');
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
}

/* ------------------------------------------------------------ side panel */

function toggleSide(tab) {
  const side = $('#side');
  if (!tab || (state.sideTab === tab && !side.classList.contains('hidden'))) {
    side.classList.add('hidden');
    state.sideTab = null;
    $$('[data-open]').forEach((b) => b.classList.remove('is-on'));
    return;
  }
  side.classList.remove('hidden');
  showTab(tab);
}

function showTab(tab) {
  state.sideTab = tab;
  $$('.tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
  $$('[data-open]').forEach((b) => b.classList.toggle('is-on', b.dataset.open === tab));
  if (tab === 'chat') {
    state.unread = 0;
    $('#chatUnread').classList.add('hidden');
    $('#chatDot').classList.add('hidden');
    $('#chatInput').focus();
  }
}

/* ------------------------------------------------------------------ misc */

function tick() {
  $('#timer').textContent = fmtDuration(Date.now() - state.startedAt);
  if (state.recorder?.active) {
    $('#recTime').textContent = fmtDuration(state.recorder.elapsed);
    $('#recSize').textContent = fmtBytes(state.recorder.bytes);
  }
}

async function copyLink() {
  const url = inviteUrl();
  if (await copyText(url)) toast('Invite link copied — send it to your team', 'success');
  else prompt('Copy this link:', url);
}

async function leave() {
  if (state.recorder?.active) {
    if (!confirm('Recording is running. Stop recording and leave?')) return;
    await stopRecording();
  }
  state.transcriber?.stop();
  state.socket?.emit('leave');
  state.mesh?.close();
  state.socket?.disconnect();
  state.local?.getTracks().forEach((t) => t.stop());
  state.screenTrack?.stop();
  location.href = '/';
}

function toast(html, type = 'info', ms = 4000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = html;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, ms);
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function linkify(text) {
  return escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

initLobby();
