/**
 * Peer-to-peer mesh built on RTCPeerConnection.
 *
 * Every participant keeps one connection per other participant. Media never
 * touches the server. Uses the "perfect negotiation" pattern so renegotiation
 * (screen share, track swaps) never deadlocks when both sides offer at once.
 */
export class Mesh {
  /**
   * @param {object} o
   * @param {import('socket.io-client').Socket} o.socket
   * @param {string} o.myId
   * @param {RTCIceServer[]} o.iceServers
   * @param {MediaStream} o.localStream
   * @param {(id:string, stream:MediaStream)=>void} o.onStream
   * @param {(id:string)=>void} [o.onPeerLeft]
   * @param {(id:string, state:RTCPeerConnectionState)=>void} [o.onConnection]
   * @param {number} [o.maxVideoBitrate]
   */
  constructor({ socket, myId, iceServers, localStream, onStream, onPeerLeft, onConnection, maxVideoBitrate = 2_500_000 }) {
    this.socket = socket;
    this.myId = myId;
    this.iceServers = iceServers;
    this.local = localStream;
    this.onStream = onStream;
    this.onPeerLeft = onPeerLeft;
    this.onConnection = onConnection;
    this.maxVideoBitrate = maxVideoBitrate;
    /** @type {Map<string, Peer>} */
    this.peers = new Map();
  }

  addPeer(id, name = 'Guest') {
    if (this.peers.has(id)) return this.peers.get(id);

    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    /** @type {Peer} */
    const peer = {
      id,
      name,
      pc,
      // Deterministic politeness: exactly one side of each pair is polite.
      polite: this.myId > id,
      makingOffer: false,
      ignoreOffer: false,
      srdAnswerPending: false,
      senders: {},
    };
    this.peers.set(id, peer);

    // Always create both m-lines, even if we have no camera/mic right now, so a
    // track can be swapped in later without a new transceiver.
    for (const kind of ['audio', 'video']) {
      const track = this.local.getTracks().find((t) => t.kind === kind) || null;
      const tr = pc.addTransceiver(track || kind, { direction: 'sendrecv', streams: [this.local] });
      peer.senders[kind] = tr.sender;
    }

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this._send(id, { description: pc.localDescription });
      } catch (err) {
        console.error('[rtc] negotiation failed', err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this._send(id, { candidate });
    };

    pc.ontrack = ({ streams, track }) => {
      const stream = streams[0];
      if (!stream) return;
      // Fire once per stream (both tracks arrive separately).
      if (peer.stream !== stream) {
        peer.stream = stream;
        this.onStream(id, stream);
      }
      track.onunmute = () => this.onStream(id, stream);
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce();
    };

    pc.onconnectionstatechange = () => {
      this.onConnection?.(id, pc.connectionState);
      if (pc.connectionState === 'connected') this._tuneSender(peer);
    };

    this.updateQuality();
    return peer;
  }

  /** Handle an incoming signaling message (perfect negotiation). */
  async handleSignal(from, data) {
    const peer = this.peers.get(from) || this.addPeer(from);
    const { pc } = peer;
    try {
      if (data.description) {
        const desc = data.description;
        const readyForOffer = !peer.makingOffer && (pc.signalingState === 'stable' || peer.srdAnswerPending);
        const collision = desc.type === 'offer' && !readyForOffer;
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;

        peer.srdAnswerPending = desc.type === 'answer';
        await pc.setRemoteDescription(desc);
        peer.srdAnswerPending = false;

        if (desc.type === 'offer') {
          await pc.setLocalDescription();
          this._send(from, { description: pc.localDescription });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!peer.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.error('[rtc] signal error', err);
    }
  }

  removePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.onnegotiationneeded = null;
    peer.pc.close();
    this.peers.delete(id);
    this.onPeerLeft?.(id);
    this.updateQuality();
  }

  /** Swap the outgoing track of one kind for every peer (camera <-> screen). */
  async replaceTrack(kind, track) {
    await Promise.all(
      [...this.peers.values()].map(async (p) => {
        const sender = p.senders[kind];
        if (!sender) return;
        await sender.replaceTrack(track);
        if (kind === 'video') this._tuneSender(p);
      }),
    );
  }

  setName(id, name) {
    const p = this.peers.get(id);
    if (p) p.name = name;
  }

  close() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }

  /**
   * Adaptive quality: in a mesh every participant uploads one stream per
   * other participant, so per-stream quality must drop as the room grows.
   * Total upload stays around 2.5–5 Mbps even with 20 people.
   */
  get tier() {
    const n = this.peers.size + 1;
    const base = this.maxVideoBitrate;
    if (n <= 4) return { maxBitrate: base, scale: 1, fps: 30 };
    if (n <= 8) return { maxBitrate: Math.min(base, 1_000_000), scale: 1.5, fps: 24 };
    if (n <= 12) return { maxBitrate: Math.min(base, 500_000), scale: 2, fps: 20 };
    return { maxBitrate: Math.min(base, 250_000), scale: 3, fps: 15 };
  }

  updateQuality() {
    for (const p of this.peers.values()) this._tuneSender(p);
  }

  async _tuneSender(peer) {
    const sender = peer.senders.video;
    if (!sender || !sender.track) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) return;
      const isScreen = sender.track.contentHint === 'detail' || sender.track.contentHint === 'text';
      const t = this.tier;
      const enc = params.encodings[0];
      if (isScreen) {
        enc.maxBitrate = Math.max(t.maxBitrate, 1_500_000);
        enc.scaleResolutionDownBy = 1;
        enc.maxFramerate = 15;
        params.degradationPreference = 'maintain-resolution';
      } else {
        enc.maxBitrate = t.maxBitrate;
        enc.scaleResolutionDownBy = t.scale;
        enc.maxFramerate = t.fps;
        params.degradationPreference = 'balanced';
      }
      await sender.setParameters(params);
    } catch (err) {
      // Not fatal – browser keeps its defaults.
      console.debug('[rtc] setParameters skipped', err?.message);
    }
  }

  _send(to, data) {
    this.socket.emit('signal', { to, data });
  }
}

/**
 * @typedef {object} Peer
 * @property {string} id
 * @property {string} name
 * @property {RTCPeerConnection} pc
 * @property {boolean} polite
 * @property {boolean} makingOffer
 * @property {boolean} ignoreOffer
 * @property {boolean} srdAnswerPending
 * @property {{audio?:RTCRtpSender, video?:RTCRtpSender}} senders
 * @property {MediaStream} [stream]
 */
