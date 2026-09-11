/**
 * Records the whole meeting (every participant's video + mixed audio) in the
 * browser, with no server involved.
 *
 * - Video: all tiles are composited onto a <canvas> (grid, or spotlight when
 *   someone shares a screen) and captured as a MediaStream.
 * - Audio: every participant's audio is mixed with the Web Audio API.
 * - Storage: chunks are streamed straight to disk with the File System Access
 *   API (Chrome/Edge), so a 3-hour recording never has to fit in RAM.
 *   Fallback: chunks are buffered in IndexedDB and assembled on stop.
 */
export class MeetingRecorder {
  /**
   * @param {object} o
   * @param {AudioContext} o.audioCtx
   * @param {() => Tile[]} o.getTiles  Called every frame; returns tiles to draw (first = local).
   * @param {number} [o.width]
   * @param {number} [o.height]
   * @param {number} [o.fps]
   * @param {number} [o.videoBitrate]
   * @param {(err:Error)=>void} [o.onError]
   */
  constructor({ audioCtx, getTiles, width = 1280, height = 720, fps = 30, videoBitrate = 2_500_000, onError }) {
    this.audioCtx = audioCtx;
    this.getTiles = getTiles;
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.videoBitrate = videoBitrate;
    this.onError = onError || ((e) => console.error(e));

    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });

    this.dest = audioCtx.createMediaStreamDestination();
    /** @type {Map<string, MediaStreamAudioSourceNode>} */
    this.sources = new Map();

    this.active = false;
    this.bytes = 0;
    this.startedAt = 0;
    this._queue = Promise.resolve();
    this._mode = null; // 'fs' | 'idb'
  }

  static supported() {
    return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
  }

  /* ------------------------------------------------------------------ audio */

  addAudio(key, stream) {
    if (this.sources.has(key)) return;
    const tracks = stream.getAudioTracks();
    if (!tracks.length) return;
    try {
      const src = this.audioCtx.createMediaStreamSource(new MediaStream(tracks));
      src.connect(this.dest);
      this.sources.set(key, src);
    } catch (err) {
      console.warn('[rec] could not add audio for', key, err);
    }
  }

  removeAudio(key) {
    const src = this.sources.get(key);
    if (!src) return;
    try { src.disconnect(); } catch { /* already gone */ }
    this.sources.delete(key);
  }

  /* --------------------------------------------------------------- control */

  /**
   * Must be called from a user gesture (the save dialog needs one).
   * @param {{fileName:string}} o
   */
  async start({ fileName }) {
    if (this.active) return;
    this.fileName = fileName;

    // Pick a sink: direct-to-disk when available, IndexedDB otherwise.
    this._mode = 'idb';
    if (window.showSaveFilePicker) {
      try {
        this._handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: 'WebM video', accept: { 'video/webm': ['.webm'] } }],
        });
        this._writable = await this._handle.createWritable();
        this._mode = 'fs';
      } catch (err) {
        if (err?.name === 'AbortError') throw err; // user cancelled
        console.warn('[rec] File System Access unavailable, using IndexedDB', err);
      }
    }
    if (this._mode === 'idb') await this._idbOpen();

    const videoTrack = this.canvas.captureStream(this.fps).getVideoTracks()[0];
    const stream = new MediaStream([videoTrack, ...this.dest.stream.getAudioTracks()]);
    this._captureTrack = videoTrack;

    const mimeType = MeetingRecorder.pickMime();
    this.recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: this.videoBitrate,
      audioBitsPerSecond: 128_000,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) this._write(e.data);
    };
    this.recorder.onerror = (e) => this.onError(e.error || new Error('MediaRecorder error'));

    this.bytes = 0;
    this.startedAt = Date.now();
    this.active = true;
    this._startTicker();
    this.recorder.start(1000); // 1 s chunks -> smooth disk writes
    return { mode: this._mode, mimeType };
  }

  /** @returns {Promise<{mode:'fs'}|{mode:'blob', url:string, name:string}>} */
  async stop() {
    if (!this.active) return null;
    this.active = false;
    this._stopTicker();

    await new Promise((resolve) => {
      this.recorder.onstop = resolve;
      try { this.recorder.stop(); } catch { resolve(); }
    });
    await this._queue;
    this._captureTrack?.stop();

    if (this._mode === 'fs') {
      await this._writable.close();
      return { mode: 'fs', name: this.fileName };
    }
    const blob = await this._idbAssemble();
    await this._idbClear();
    return { mode: 'blob', url: URL.createObjectURL(blob), name: this.fileName, size: blob.size };
  }

  get elapsed() {
    return this.active ? Date.now() - this.startedAt : 0;
  }

  /* ----------------------------------------------------------------- sinks */

  _write(blob) {
    this.bytes += blob.size;
    this._queue = this._queue
      .then(() => (this._mode === 'fs' ? this._writable.write(blob) : this._idbPut(blob)))
      .catch((err) => {
        this.onError(err);
        this.active = false;
        try { this.recorder.stop(); } catch { /* noop */ }
      });
  }

  _idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('teammeet-rec', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('chunks', { autoIncrement: true });
      req.onsuccess = () => { this._db = req.result; this._idbClear().then(resolve, reject); };
      req.onerror = () => reject(req.error);
    });
  }

  _idbPut(blob) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').add(blob);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  _idbAssemble() {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('chunks', 'readonly');
      const req = tx.objectStore('chunks').getAll();
      req.onsuccess = () => resolve(new Blob(req.result, { type: 'video/webm' }));
      req.onerror = () => reject(req.error);
    });
  }

  _idbClear() {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  /* --------------------------------------------------------------- drawing */

  // A Worker-driven timer keeps painting even when the tab is in the
  // background, where requestAnimationFrame stops entirely.
  _startTicker() {
    const src = 'let t;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}';
    this._worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    this._worker.onmessage = () => this._draw();
    this._worker.postMessage(Math.round(1000 / this.fps));
  }

  _stopTicker() {
    this._worker?.postMessage(0);
    this._worker?.terminate();
    this._worker = null;
  }

  _draw() {
    const { ctx, width: W, height: H } = this;
    const tiles = this.getTiles();

    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, W, H);

    if (!tiles.length) return;

    const screenIdx = tiles.findIndex((t) => t.isScreen);
    const gap = 12;
    let rects;
    if (screenIdx >= 0 && tiles.length > 1) {
      const others = tiles.filter((_, i) => i !== screenIdx);
      rects = spotlightRects(others.length, W, H, gap);
      drawTile(ctx, tiles[screenIdx], rects.main, true);
      others.forEach((t, i) => drawTile(ctx, t, rects.side[i], false));
    } else {
      rects = gridRects(tiles.length, W, H, gap);
      tiles.forEach((t, i) => drawTile(ctx, t, rects[i], t.isScreen));
    }

    // REC badge + clock
    const elapsed = fmtDuration(this.elapsed);
    ctx.font = '600 16px system-ui, sans-serif';
    const text = `REC  ${elapsed}`;
    const tw = ctx.measureText(text).width + 34;
    roundRect(ctx, W - tw - 14, 12, tw, 30, 15);
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fill();
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(W - tw - 14 + 16, 27, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W - tw - 14 + 28, 27);
  }

  static pickMime() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=h264,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ];
    return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || '';
  }
}

/* -------------------------------------------------------------- helpers */

function drawTile(ctx, tile, r, contain) {
  const { x, y, w, h } = r;
  ctx.save();
  roundRect(ctx, x, y, w, h, 14);
  ctx.clip();
  ctx.fillStyle = '#171a21';
  ctx.fillRect(x, y, w, h);

  const v = tile.video;
  const hasFrame = v && !tile.camOff && v.readyState >= 2 && v.videoWidth > 0;
  if (hasFrame) {
    const vw = v.videoWidth, vh = v.videoHeight;
    if (contain) {
      const s = Math.min(w / vw, h / vh);
      const dw = vw * s, dh = vh * s;
      ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else {
      const s = Math.max(w / vw, h / vh);
      const sw = w / s, sh = h / s;
      ctx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, h);
    }
  } else {
    // Avatar with initials
    const rad = Math.min(w, h) * 0.18;
    ctx.fillStyle = tile.color || '#4f8cff';
    ctx.beginPath();
    ctx.arc(x + w / 2, y + h / 2, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${Math.round(rad * 0.9)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials(tile.name), x + w / 2, y + h / 2 + rad * 0.05);
    ctx.textAlign = 'left';
  }

  // Name label
  const label = tile.name + (tile.muted ? '  🔇' : '');
  ctx.font = '500 15px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const lw = Math.min(ctx.measureText(label).width + 22, w - 20);
  roundRect(ctx, x + 10, y + h - 40, lw, 28, 8);
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(label, x + 21, y + h - 26, lw - 22);
  ctx.restore();

  if (tile.speaking) {
    ctx.save();
    roundRect(ctx, x + 1.5, y + 1.5, w - 3, h - 3, 14);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#22c55e';
    ctx.stroke();
    ctx.restore();
  }
}

function gridRects(n, W, H, gap) {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cw = (W - gap * (cols + 1)) / cols;
  const ch = (H - gap * (rows + 1)) / rows;
  const rects = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    let w = cw, h = (cw * 9) / 16;
    if (h > ch) { h = ch; w = (ch * 16) / 9; }
    rects.push({ x: gap + c * (cw + gap) + (cw - w) / 2, y: gap + r * (ch + gap) + (ch - h) / 2, w, h });
  }
  // Centre an incomplete last row.
  const lastCount = n - (rows - 1) * cols;
  if (lastCount < cols) {
    const off = ((cols - lastCount) * (cw + gap)) / 2;
    for (let i = (rows - 1) * cols; i < n; i++) rects[i].x += off;
  }
  return rects;
}

function spotlightRects(nSide, W, H, gap) {
  const sideW = nSide ? Math.round(W * 0.22) : 0;
  const main = { x: gap, y: gap, w: W - sideW - gap * (nSide ? 3 : 2), h: H - gap * 2 };
  const side = [];
  if (nSide) {
    const availH = H - gap * (nSide + 1);
    let h = (sideW * 9) / 16;
    if (h * nSide > availH) h = availH / nSide;
    const w = Math.min(sideW, (h * 16) / 9);
    const x = W - gap - sideW + (sideW - w) / 2;
    for (let i = 0; i < nSide; i++) side.push({ x, y: gap + i * (h + gap), w, h });
  }
  return { main, side };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase() || '').join('') || '?';
}

export function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function fmtBytes(b) {
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * @typedef {object} Tile
 * @property {HTMLVideoElement} video
 * @property {string} name
 * @property {boolean} [muted]
 * @property {boolean} [camOff]
 * @property {boolean} [isScreen]
 * @property {boolean} [speaking]
 * @property {string} [color]
 */
