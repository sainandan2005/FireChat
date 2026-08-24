"use client";

export interface SignalSender {
  send(type: string, payload?: unknown): void;
}
export type CallState = "outgoing" | "incoming" | "connecting" | "connected" | "ended";

export interface ActiveCall {
  callId: string;
  peerId: string;
  peerUsername: string;
  video: boolean;
  direction: "in" | "out";
  state: CallState;
  startedAt?: number;
}

export interface CallHooks {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  activeCall: ActiveCall | null;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ],
};

export const RING_TIMEOUT_MS = 32_000;

export class CallEngine {
  private socket: SignalSender;
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private ringTimer: ReturnType<typeof setTimeout> | null = null;

  call: ActiveCall | null = null;

  constructor(socket: SignalSender) {
    this.socket = socket;
  }

  private signal(kind: "description" | "candidate", data: unknown): void {
    if (!this.call) return;
    this.socket.send("call.signal", {
      toUserId: this.call.peerId,
      callId: this.call.callId,
      kind,
      data,
    });
  }

  private async buildPeer(): Promise<RTCPeerConnection> {
    if (!this.call) throw new Error("no active call");
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal("candidate", e.candidate.toJSON());
    };
    pc.ontrack = (e) => {
      if (this.onRemoteStream) this.onRemoteStream(e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (!this.call) return;
      if (pc.connectionState === "connected") this.setState("connected");
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.teardown();
    };
    this.pc = pc;
    return pc;
  }

  onStateChange?: (call: ActiveCall | null) => void;
  onLocalStream?: (stream: MediaStream | null) => void;
  onRemoteStream?: (stream: MediaStream | null) => void;

  private setState(state: CallState): void {
    if (!this.call) return;
    this.call = { ...this.call, state };
    if (state === "connected") this.call.startedAt = Date.now();
    this.onStateChange?.(this.call);
  }

  async start(peerId: string, peerUsername: string, video: boolean): Promise<void> {
    const callId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.call = { callId, peerId, peerUsername, video, direction: "out", state: "outgoing" };
    this.onStateChange?.(this.call);

    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    this.onLocalStream?.(this.localStream);

    this.socket.send("call.ring", { toUserId: peerId, callId, video });

    this.ringTimer = setTimeout(() => {
      if (this.call?.state === "outgoing") this.hangup("timeout");
    }, RING_TIMEOUT_MS);
  }

  /** Caller proceeds once the callee accepted. */
  async beginOffer(): Promise<void> {
    if (!this.call || this.call.direction !== "out") return;
    this.setState("connecting");
    const pc = await this.buildPeer();
    for (const track of this.localStream?.getTracks() ?? []) pc.addTrack(track, this.localStream!);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signal("description", offer);
  }

  /** Callee accepts an incoming ring. */
  async accept(): Promise<void> {
    if (!this.call || this.call.direction !== "in") return;
    this.clearRingTimer();
    this.setState("connecting");
    this.socket.send("call.accept", {
      toUserId: this.call.peerId,
      callId: this.call.callId,
    });
  }

  decline(): void {
    if (!this.call) return;
    this.socket.send("call.end", {
      toUserId: this.call.peerId,
      callId: this.call.callId,
      reason: "declined",
    });
    this.teardown();
  }

  hangup(reason = "hangup"): void {
    if (!this.call) return;
    this.socket.send("call.end", {
      toUserId: this.call.peerId,
      callId: this.call.callId,
      reason,
    });
    this.teardown();
  }

  /* ---- inbound signaling (wired by the provider) ---- */

  async onIncoming(payload: {
    callId: string;
    fromUserId: string;
    fromUsername: string;
    video: boolean;
  }): Promise<boolean> {
    if (this.call && this.call.state !== "ended") return false; // busy
    this.call = {
      callId: payload.callId,
      peerId: payload.fromUserId,
      peerUsername: payload.fromUsername,
      video: payload.video,
      direction: "in",
      state: "incoming",
    };
    this.onStateChange?.(this.call);

    this.ringTimer = setTimeout(() => {
      if (this.call?.state === "incoming") this.decline();
    }, RING_TIMEOUT_MS);
    return true;
  }

  onAccepted(): Promise<void> {
    return this.beginOffer();
  }

  async onSignal(kind: string, data: unknown): Promise<void> {
    if (!this.call) return;

    if (kind === "description") {
      const desc = data as RTCSessionDescriptionInit;

      // callee path: build the peer connection lazily when the offer arrives
      if (!this.pc) {
        const pc = await this.buildPeer();
        this.pc = pc;
        if (!this.localStream) {
          this.localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: this.call.video,
          });
          this.onLocalStream?.(this.localStream);
        }
        for (const track of this.localStream.getTracks()) {
          pc.addTrack(track, this.localStream);
        }
      }

      const pc = this.pc;
      await pc.setRemoteDescription(new RTCSessionDescription(desc));
      if (desc.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signal("description", answer);
      }
      return;
    }

    if (kind === "candidate") {
      if (!this.pc) return;
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(data as RTCIceCandidateInit));
      } catch {
        /* stale candidate */
      }
    }
  }

  onEnded(): void {
    this.teardown();
  }

  private clearRingTimer(): void {
    if (this.ringTimer) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }
  }

  teardown(): void {
    this.clearRingTimer();
    this.pc?.close();
    this.pc = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.onLocalStream?.(null);
    this.onRemoteStream?.(null);
    if (this.call) {
      this.call = { ...this.call, state: "ended" };
      this.onStateChange?.(this.call);
      const ended = this.call;
      setTimeout(() => {
        if (this.call === ended) {
          this.call = null;
          this.onStateChange?.(null);
        }
      }, 1200);
    } else {
      this.onStateChange?.(null);
    }
  }
}
