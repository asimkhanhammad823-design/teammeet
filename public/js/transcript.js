/**
 * Live transcription.
 *
 * Each participant transcribes their OWN microphone with the browser's built-in
 * speech recognition (free, Chrome/Edge) and broadcasts final sentences to the
 * room. Every participant therefore ends up with the full, speaker-labelled
 * transcript of the meeting without any paid API.
 */
export class Transcriber {
  static supported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /**
   * @param {object} o
   * @param {string} o.lang               BCP-47 tag, e.g. "en-US", "ur-PK"
   * @param {(text:string)=>void} o.onInterim
   * @param {(text:string)=>void} o.onFinal
   * @param {(status:'listening'|'stopped'|'denied'|'error', detail?:string)=>void} [o.onStatus]
   */
  constructor({ lang = 'en-US', onInterim, onFinal, onStatus }) {
    this.lang = lang;
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onStatus = onStatus || (() => {});
    this.active = false;
    this._backoff = 250;
  }

  start() {
    if (this.active || !Transcriber.supported()) return;
    this.active = true;
    this._spawn();
  }

  stop() {
    this.active = false;
    try { this.rec?.stop(); } catch { /* noop */ }
    this.onInterim('');
  }

  setLang(lang) {
    this.lang = lang;
    // abort() triggers onend, which respawns with the new language.
    if (this.active) { try { this.rec?.abort(); } catch { /* noop */ } }
  }

  _spawn() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0]?.transcript?.trim();
        if (!text) continue;
        if (res.isFinal) this.onFinal(text);
        else interim += text + ' ';
      }
      this.onInterim(interim.trim());
      this._backoff = 250;
    };

    rec.onerror = (e) => {
      switch (e.error) {
        case 'not-allowed':
        case 'service-not-allowed':
          this.active = false;
          this.onStatus('denied', e.error);
          break;
        case 'network':
          this._backoff = Math.min(this._backoff * 2, 8000);
          this.onStatus('error', 'network');
          break;
        case 'no-speech':
        case 'aborted':
          break; // normal: onend will restart
        default:
          this.onStatus('error', e.error);
      }
    };

    // Chrome ends a continuous session after silence / ~60s; just restart.
    rec.onend = () => {
      if (this.active) setTimeout(() => this.active && this._spawn(), this._backoff);
      else this.onStatus('stopped');
    };

    try {
      rec.start();
      this.rec = rec;
      this.onStatus('listening');
    } catch (err) {
      this.onStatus('error', err?.message);
    }
  }
}

/** Ordered, exportable transcript of the meeting. */
export class TranscriptLog {
  constructor({ storageKey, meetingStart }) {
    this.storageKey = storageKey;
    this.meetingStart = meetingStart;
    /** @type {{name:string, text:string, ts:number, from:string}[]} */
    this.entries = [];
    this._restore();
  }

  add(entry) {
    this.entries.push(entry);
    this._persist();
    return entry;
  }

  clear() {
    this.entries = [];
    this._persist();
  }

  get isEmpty() {
    return this.entries.length === 0;
  }

  toTXT(title = 'Meeting transcript') {
    const lines = [title, `Date: ${new Date(this.meetingStart).toLocaleString()}`, ''];
    for (const e of this.entries) lines.push(`[${clock(e.ts - this.meetingStart)}] ${e.name}: ${e.text}`);
    return lines.join('\n');
  }

  toSRT() {
    const out = [];
    this.entries.forEach((e, i) => {
      const start = Math.max(0, e.ts - this.meetingStart);
      const natural = Math.min(7000, Math.max(1500, e.text.length * 60));
      const next = this.entries[i + 1];
      const end = next ? Math.min(next.ts - this.meetingStart, start + natural) : start + natural;
      out.push(`${i + 1}\n${srtTime(start)} --> ${srtTime(Math.max(end, start + 500))}\n${e.name}: ${e.text}\n`);
    });
    return out.join('\n');
  }

  toJSON() {
    return JSON.stringify(
      { meetingStart: this.meetingStart, entries: this.entries.map((e) => ({ ...e, offsetMs: e.ts - this.meetingStart })) },
      null,
      2,
    );
  }

  _persist() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ meetingStart: this.meetingStart, entries: this.entries, savedAt: Date.now() }));
    } catch { /* storage full or disabled */ }
  }

  _restore() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const data = JSON.parse(raw);
      // Keep a transcript only if it belongs to the same (still running) meeting.
      if (data.meetingStart === this.meetingStart && Date.now() - data.savedAt < 12 * 3600e3) {
        this.entries = data.entries || [];
      }
    } catch { /* ignore */ }
  }
}

export function download(name, content, type = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

function srtTime(ms) {
  return `${clock(ms)},${String(Math.max(0, ms) % 1000).padStart(3, '0')}`;
}

export const LANGUAGES = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-IN', 'English (India)'],
  ['ur-PK', 'اردو (Urdu)'],
  ['hi-IN', 'हिन्दी (Hindi)'],
  ['ar-SA', 'العربية (Arabic)'],
  ['pa-Guru-IN', 'ਪੰਜਾਬੀ (Punjabi)'],
  ['bn-BD', 'বাংলা (Bengali)'],
  ['tr-TR', 'Türkçe'],
  ['de-DE', 'Deutsch'],
  ['fr-FR', 'Français'],
  ['es-ES', 'Español'],
  ['zh-CN', '中文 (简体)'],
];
