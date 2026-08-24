"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { getWs } from "@/lib/ws-client";
import { CallEngine, type ActiveCall } from "@/lib/webrtc";
import type {
  CallEndedPayload,
  CallIncomingPayload,
  CallSignalPayload,
  PresenceUpdatePayload,
} from "@/lib/types";
import CallDialog from "./CallDialog";

interface MeInfo {
  id: string;
  username: string;
  avatarUrl: string | null;
}

interface ChatContextValue {
  onlineIds: Set<string>;
  me: MeInfo | null;
  callEngine: CallEngine | null;
}

const ChatContext = createContext<ChatContextValue>({
  onlineIds: new Set<string>(),
  me: null,
  callEngine: null,
});

export function useChat(): ChatContextValue {
  return useContext(ChatContext);
}

function matchesActiveCall(engine: CallEngine, callId: string): boolean {
  return engine.call?.callId === callId;
}

export default function ChatProviders({
  me,
  children,
}: {
  me?: MeInfo;
  children: ReactNode;
}) {
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [engine, setEngine] = useState<CallEngine | null>(null);

  useEffect(() => {
    const client = getWs();

    const callEngineInstance = new CallEngine(client);
    callEngineInstance.onStateChange = (call) => setActiveCall(call ? { ...call } : null);
    callEngineInstance.onLocalStream = (s) => setLocalStream(s);
    callEngineInstance.onRemoteStream = (s) => setRemoteStream(s);
    queueMicrotask(() => setEngine(callEngineInstance));

    client.connect();

    const offList = client.on("presence.list", (payload) => {
      setOnlineIds(new Set((payload as string[]) ?? []));
    });
    const offUpdate = client.on("presence.update", (payload) => {
      const p = payload as PresenceUpdatePayload;
      setOnlineIds((prev) => {
        const next = new Set(prev);
        if (p.online) next.add(p.userId);
        else next.delete(p.userId);
        return next;
      });
    });

    const offIncoming = client.on("call.incoming", async (raw) => {
      await callEngineInstance.onIncoming(raw as CallIncomingPayload);
    });
    const offAccepted = client.on("call.accepted", async () => {
      await callEngineInstance.onAccepted();
    });
    const offSignal = client.on("call.signal", async (raw) => {
      const p = raw as CallSignalPayload;
      if (matchesActiveCall(callEngineInstance, p.callId)) {
        await callEngineInstance.onSignal(p.kind, p.data);
      }
    });
    const offEnded = client.on("call.ended", (raw) => {
      const p = raw as CallEndedPayload;
      if (matchesActiveCall(callEngineInstance, p.callId)) {
        callEngineInstance.onEnded();
      }
    });

    return () => {
      offList();
      offUpdate();
      offIncoming();
      offAccepted();
      offSignal();
      offEnded();
      client.close();
    };
  }, []);

  return (
    <ChatContext.Provider
      value={{ onlineIds, me: me ?? null, callEngine: engine }}
    >
      {children}
      {activeCall && (
        <CallDialog
          call={activeCall}
          localStream={localStream}
          remoteStream={remoteStream}
          callEngine={engine}
        />
      )}
    </ChatContext.Provider>
  );
}
