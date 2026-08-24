"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from "lucide-react";
import Avatar from "./Avatar";
import type { ActiveCall, CallEngine } from "@/lib/webrtc";

function formatElapsed(startedAt: number): string {
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const STATE_LABELS: Record<ActiveCall["state"], string> = {
  outgoing: "Calling…",
  incoming: "Incoming call",
  connecting: "Connecting…",
  connected: "",
  ended: "Call ended",
};

export default function CallDialog({
  call,
  localStream,
  remoteStream,
  callEngine,
}: {
  call: ActiveCall;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  callEngine: CallEngine | null;
}) {
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [elapsed, setElapsed] = useState("00:00");
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (remoteStream && remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
    if (localStream && localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
    if (remoteStream && remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream;
    }
  }, [remoteStream, localStream]);

  useEffect(() => {
    if (call.state !== "connected" || !call.startedAt) return;
    const t = setInterval(() => setElapsed(formatElapsed(call.startedAt!)), 500);
    return () => clearInterval(t);
  }, [call.state, call.startedAt]);

  const connected = call.state === "connected";
  const isIncomingRinging = call.state === "incoming" && call.direction === "in";
  const showVideo = call.video;

  function toggleMute() {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = muted;
    setMuted(!muted);
  }

  function toggleCamera() {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = cameraOff;
    setCameraOff(!cameraOff);
  }

  return (
    <div className="fixed inset-0 z-[80] flex animate-fade-in items-center justify-center bg-canvas/95 backdrop-blur-2xl">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 p-6 text-center">
        {showVideo ? (
          <div className="relative w-full overflow-hidden rounded-2xl border border-ink-600 bg-ink-900 shadow-2xl">
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="aspect-[3/4] w-full object-cover"
            />
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="absolute bottom-3 right-3 h-28 w-20 rounded-lg border border-ink-600 object-cover"
            />
          </div>
        ) : (
          <>
            <div className="relative">
            <div className={call.state === "incoming" || call.state === "outgoing" ? "animate-pulse" : ""}>
              <Avatar username={call.peerUsername} size="lg" />
            </div>
          </div>
            <h2 className="font-display text-xl font-semibold text-mist-200">{call.peerUsername}</h2>
          </>
        )}

        <p
          className={`text-sm ${
            connected ? "font-mono text-online" : call.state === "ended" ? "text-mist-400" : "animate-pulse text-mist-300"
          }`}
        >
          {connected ? elapsed : STATE_LABELS[call.state]}
        </p>

        {!showVideo && !connected && !isIncomingRinging && (
          <div className="flex items-center gap-1 opacity-70">
            {[...Array(5)].map((_, i) => (
              <span
                key={i}
                className="h-6 w-1 animate-pulse rounded bg-accent-400"
                style={{ animationDelay: `${i * 120}ms` }}
              />
            ))}
          </div>
        )}

        <div className="mt-4 flex items-center justify-center gap-5 rounded-2xl border border-ink-600 bg-ink-900 px-6 py-3">
          {isIncomingRinging ? (
            <>
              <button
                onClick={() => callEngine?.decline()}
                aria-label="Decline call"
                className="flex size-16 items-center justify-center rounded-full bg-red-600 text-white transition hover:bg-red-500"
              >
                <PhoneOff className="size-7" />
              </button>
              <button
                onClick={() => callEngine?.accept()}
                aria-label="Accept call"
                className="flex size-16 animate-pulse items-center justify-center rounded-full bg-go text-white transition hover:brightness-110"
              >
                <Phone className="size-7" />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={toggleMute}
                aria-label={muted ? "Unmute" : "Mute"}
                className={`flex size-12 items-center justify-center rounded-full transition ${
                  muted ? "bg-mist-200 text-canvas" : "bg-ink-700 text-mist-200 hover:bg-ink-600"
                }`}
              >
                {muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
              </button>

              <button
                onClick={() => callEngine?.hangup()}
                aria-label="End call"
                className="flex size-16 items-center justify-center rounded-full bg-red-600 text-white transition hover:bg-red-500"
              >
                <PhoneOff className="size-7" />
              </button>

              {showVideo && (
                <button
                  onClick={toggleCamera}
                  aria-label={cameraOff ? "Turn camera on" : "Turn camera off"}
                  className={`flex size-12 items-center justify-center rounded-full transition ${
                    cameraOff ? "bg-mist-200 text-white" : "bg-ink-700 text-mist-200 hover:bg-ink-600"
                  }`}
                >
                  {cameraOff ? <VideoOff className="size-5" /> : <Video className="size-5" />}
                </button>
              )}
            </>
          )}
        </div>

        {!showVideo && <audio ref={remoteAudioRef} autoPlay />}
      </div>
    </div>
  );
}
