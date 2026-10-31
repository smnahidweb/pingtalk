"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { apiRequest } from "@/lib/api";

export type CallType = "AUDIO" | "VIDEO";
export type CallMode = "ONE_TO_ONE" | "GROUP";

export type CallParticipant = {
  id: string;
  name: string;
  image: string | null;
  joinedAt: number;
};

export type ActiveCall = {
  id: string;
  conversationId: string;
  conversationName: string;
  callType: CallType;
  mode: CallMode;
  status: "ringing" | "active";
  caller: Omit<CallParticipant, "joinedAt">;
  participants: CallParticipant[];
  pendingUserIds: string[];
  startedAt: number;
};

type CallResponse = {
  ok: boolean;
  call?: ActiveCall;
  error?: { code: string; message: string };
};

type SignalMessage = {
  callId: string;
  fromUserId: string;
  signalType: "offer" | "answer" | "ice";
  data: Record<string, unknown>;
};

type CallNotificationPermission = NotificationPermission | "unsupported";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

function getCallError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Allow microphone and camera access in your browser to join the call.";
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return "A microphone or camera required for this call was not found.";
    }
    if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      return "Your microphone or camera is already in use by another application.";
    }
  }
  return error instanceof Error ? error.message : "The call could not be completed.";
}

function parseSessionDescription(data: Record<string, unknown>): RTCSessionDescriptionInit {
  const type = data.type;
  if (
    type !== "offer" &&
    type !== "answer" &&
    type !== "pranswer" &&
    type !== "rollback"
  ) {
    throw new Error("The call offer or answer was invalid.");
  }
  if (typeof data.sdp !== "string") {
    throw new Error("The call offer or answer was missing session details.");
  }
  return { type, sdp: data.sdp };
}

function parseIceCandidate(data: Record<string, unknown>): RTCIceCandidateInit {
  if (typeof data.candidate !== "string") {
    throw new Error("The network candidate was invalid.");
  }
  return {
    candidate: data.candidate,
    sdpMid: typeof data.sdpMid === "string" ? data.sdpMid : null,
    sdpMLineIndex:
      typeof data.sdpMLineIndex === "number" ? data.sdpMLineIndex : null,
    usernameFragment:
      typeof data.usernameFragment === "string"
        ? data.usernameFragment
        : undefined,
  };
}

export function useCalling(socket: Socket | null, userId: string) {
  const [incomingCall, setIncomingCall] = useState<ActiveCall | null>(null);
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [status, setStatus] = useState("Idle");
  const [error, setError] = useState("");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [muted, setMuted] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [soundError, setSoundError] = useState("");
  const [notificationPermission, setNotificationPermission] =
    useState<CallNotificationPermission>("unsupported");

  const callRef = useRef(call);
  const incomingCallRef = useRef(incomingCall);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const pendingIceRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const callActionInProgressRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const ringtoneTimerRef = useRef<number | null>(null);
  const vibrationTimerRef = useRef<number | null>(null);
  const ringtoneCallIdRef = useRef<string | null>(null);
  const notificationRef = useRef<Notification | null>(null);
  const notificationCallIdRef = useRef<string | null>(null);
  const ringtoneOscillatorsRef = useRef(new Set<OscillatorNode>());
  const scheduleRingtoneRef = useRef<() => void>(() => {});
  const iceServersRef = useRef<RTCIceServer[]>(ICE_SERVERS);

  const loadIceServers = useCallback(async () => {
    try {
      const result = await apiRequest<{ iceServers: RTCIceServer[] }>(
        "/calls/ice-servers",
      );
      if (!Array.isArray(result.iceServers) || result.iceServers.length === 0) {
        throw new Error("ICE configuration was empty.");
      }
      iceServersRef.current = result.iceServers;
      console.info("[PingTalk calls] ICE configuration loaded", {
        turnConfigured: result.iceServers.some((server) => {
          const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
          return urls.some((url) => /^turns?:/i.test(url));
        }),
      });
    } catch (error) {
      iceServersRef.current = ICE_SERVERS;
      console.warn("[PingTalk calls] ICE configuration unavailable; using STUN", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }, []);

  const stopIncomingAlerts = useCallback((callId?: string) => {
    if (callId && ringtoneCallIdRef.current !== callId) return;
    ringtoneCallIdRef.current = null;
    if (ringtoneTimerRef.current !== null) {
      window.clearTimeout(ringtoneTimerRef.current);
      ringtoneTimerRef.current = null;
    }
    if (vibrationTimerRef.current !== null) {
      window.clearInterval(vibrationTimerRef.current);
      vibrationTimerRef.current = null;
    }
    for (const oscillator of ringtoneOscillatorsRef.current) {
      try {
        oscillator.stop();
      } catch {
        // An oscillator may already have stopped after its tone finished.
      }
    }
    ringtoneOscillatorsRef.current.clear();
    if ("vibrate" in navigator) {
      try {
        navigator.vibrate(0);
      } catch {
        // Vibration can be unavailable while the document is inactive.
      }
    }
    if (!callId || notificationCallIdRef.current === callId) {
      notificationRef.current?.close();
      notificationRef.current = null;
      notificationCallIdRef.current = null;
    }
  }, []);

  const playRingtoneTone = useCallback((frequency: number, startAt: number) => {
    const context = audioContextRef.current;
    if (!context || context.state !== "running") return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.12, startAt + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.2);
    oscillator.connect(gain);
    gain.connect(context.destination);
    ringtoneOscillatorsRef.current.add(oscillator);
    oscillator.onended = () => {
      ringtoneOscillatorsRef.current.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(startAt);
    oscillator.stop(startAt + 0.21);
  }, []);

  const scheduleRingtone = useCallback(() => {
    const context = audioContextRef.current;
    if (!ringtoneCallIdRef.current || !context || context.state !== "running") return;
    if (ringtoneTimerRef.current !== null) {
      window.clearTimeout(ringtoneTimerRef.current);
    }
    const startedAt = context.currentTime + 0.02;
    playRingtoneTone(660, startedAt);
    playRingtoneTone(880, startedAt + 0.28);
    ringtoneTimerRef.current = window.setTimeout(() => {
      scheduleRingtoneRef.current();
    }, 1500);
  }, [playRingtoneTone]);

  const showCallNotification = useCallback((incoming: ActiveCall) => {
    if (
      typeof Notification === "undefined" ||
      Notification.permission !== "granted" ||
      notificationCallIdRef.current === incoming.id
    ) {
      return;
    }
    try {
      const notification = new Notification(
        `${incoming.caller.name} is calling`,
        {
          body:
            incoming.mode === "GROUP"
              ? `${incoming.callType === "AUDIO" ? "Audio" : "Video"} call · ${incoming.conversationName}`
              : `${incoming.callType === "AUDIO" ? "Audio" : "Video"} call`,
          tag: `pingtalk-call-${incoming.id}`,
          silent: true,
        },
      );
      notificationCallIdRef.current = incoming.id;
      notificationRef.current = notification;
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } catch (reason) {
      console.warn("[PingTalk calls] browser notification failed", reason);
    }
  }, []);

  const startIncomingAlerts = useCallback((incoming: ActiveCall) => {
    if (ringtoneCallIdRef.current === incoming.id) return;
    stopIncomingAlerts();
    ringtoneCallIdRef.current = incoming.id;
    setSoundError("");
    if ("vibrate" in navigator) {
      try {
        navigator.vibrate([350, 250, 350, 900]);
        vibrationTimerRef.current = window.setInterval(() => {
          try {
            navigator.vibrate([350, 250, 350, 900]);
          } catch {
            if (vibrationTimerRef.current !== null) {
              window.clearInterval(vibrationTimerRef.current);
              vibrationTimerRef.current = null;
            }
          }
        }, 1900);
      } catch {
        vibrationTimerRef.current = null;
      }
    }
    if (audioContextRef.current?.state === "running") scheduleRingtone();
    showCallNotification(incoming);
  }, [scheduleRingtone, showCallNotification, stopIncomingAlerts]);

  const enableCallSound = useCallback(async () => {
    try {
      let context = audioContextRef.current;
      if (!context || context.state === "closed") {
        context = new AudioContext();
        audioContextRef.current = context;
        context.onstatechange = () => {
          const enabled = context?.state === "running";
          setSoundEnabled(enabled);
          if (enabled && ringtoneCallIdRef.current) scheduleRingtone();
        };
      }
      if (context.state !== "running") await context.resume();
      const enabled = context.state === "running";
      setSoundEnabled(enabled);
      setSoundError(
        enabled ? "" : "Sound is blocked. Tap Enable ringtone to try again.",
      );
      if (enabled && ringtoneCallIdRef.current) scheduleRingtone();
    } catch (reason) {
      setSoundEnabled(false);
      setSoundError("This browser cannot play the ringtone. Use the on-screen call controls.");
      console.warn("[PingTalk calls] ringtone playback is unavailable", reason);
    }
  }, [scheduleRingtone]);

  const requestCallNotifications = useCallback(async () => {
    if (typeof Notification === "undefined") {
      setNotificationPermission("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setNotificationPermission("denied");
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      const currentIncoming = incomingCallRef.current;
      if (permission === "granted" && currentIncoming) {
        showCallNotification(currentIncoming);
      }
    } catch (reason) {
      console.warn("[PingTalk calls] notification permission request failed", reason);
    }
  }, [showCallNotification]);

  useEffect(() => {
    callRef.current = call;
    incomingCallRef.current = incomingCall;
  }, [call, incomingCall]);

  useEffect(() => {
    scheduleRingtoneRef.current = scheduleRingtone;
  }, [scheduleRingtone]);

  useEffect(() => {
    const oscillators = ringtoneOscillatorsRef.current;
    const permissionTimer = window.setTimeout(() => {
      if (typeof Notification !== "undefined") {
        setNotificationPermission(Notification.permission);
      }
    }, 0);
    const unlockAudio = () => {
      void enableCallSound();
    };
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    window.addEventListener("keydown", unlockAudio, { once: true });
    return () => {
      window.clearTimeout(permissionTimer);
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
      stopIncomingAlerts();
      for (const oscillator of oscillators) {
        try {
          oscillator.stop();
        } catch {
          // An oscillator may already have stopped after its tone finished.
        }
      }
      if (audioContextRef.current) {
        audioContextRef.current.onstatechange = null;
      }
      void audioContextRef.current?.close();
      audioContextRef.current = null;
    };
  }, [enableCallSound, stopIncomingAlerts]);

  const stopMedia = useCallback(() => {
    for (const peer of peersRef.current.values()) peer.close();
    peersRef.current.clear();
    pendingIceRef.current.clear();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteStreams({});
  }, []);

  const clearCall = useCallback(() => {
    stopMedia();
    callRef.current = null;
    incomingCallRef.current = null;
    setCall(null);
    setIncomingCall(null);
    setStatus("Idle");
    setMuted(false);
    setCameraEnabled(true);
    setElapsedSeconds(0);
  }, [stopMedia]);

  const getLocalMedia = useCallback(async (callType: CallType) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Audio and video calls are not supported by this browser.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === "VIDEO",
    });
    localStreamRef.current = stream;
    setLocalStream(stream);
    setCameraEnabled(callType === "VIDEO");
    return stream;
  }, []);

  const sendSignal = useCallback(
    (toUserId: string, signalType: SignalMessage["signalType"], data: object) => {
      const currentCall = callRef.current;
      if (!socket?.connected || !currentCall) return;
      socket.timeout(5_000).emit("call:signal", {
        callId: currentCall.id,
        toUserId,
        signalType,
        data,
      }, (timeoutError: Error | null, response: CallResponse) => {
        if (timeoutError) {
          console.warn("[PingTalk calls] signaling acknowledgement timed out", {
            signalType,
          });
        } else if (!response?.ok) {
          console.warn("[PingTalk calls] signaling rejected", {
            signalType,
            errorCode: response?.error?.code ?? "UNKNOWN",
          });
        }
      });
    },
    [socket],
  );

  const createPeer = useCallback(
    (remoteUserId: string) => {
      const existing = peersRef.current.get(remoteUserId);
      if (existing) return existing;

      const peer = new RTCPeerConnection({ iceServers: iceServersRef.current });
      const stream = localStreamRef.current;
      stream?.getTracks().forEach((track) => peer.addTrack(track, stream));
      peer.onicecandidate = (event) => {
        if (event.candidate) {
          console.info("[PingTalk calls] local ICE candidate", {
            type: event.candidate.type,
            protocol: event.candidate.protocol,
          });
          sendSignal(remoteUserId, "ice", event.candidate.toJSON());
        } else {
          console.info("[PingTalk calls] local ICE gathering complete");
        }
      };
      peer.ontrack = (event) => {
        const remoteStream =
          event.streams[0] ?? new MediaStream([event.track]);
        setRemoteStreams((current) => ({
          ...current,
          [remoteUserId]: remoteStream,
        }));
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") {
          setStatus("Connected");
        } else if (peer.connectionState === "connecting") {
          setStatus("Connecting");
        } else if (peer.connectionState === "disconnected") {
          setStatus("Reconnecting");
        } else if (peer.connectionState === "failed") {
          setStatus("Connection failed");
        }
      };
      peer.oniceconnectionstatechange = () => {
        const iceState = peer.iceConnectionState;
        console.info("[PingTalk calls] ICE connection state", {
          iceState,
          connectionState: peer.connectionState,
          gatheringState: peer.iceGatheringState,
        });
        if (iceState === "checking") {
          setStatus("Connecting");
        } else if (iceState === "connected" || iceState === "completed") {
          setStatus("Connected");
        } else if (iceState === "disconnected") {
          setStatus("Reconnecting");
        } else if (iceState === "failed") {
          setStatus("Connection failed");
        }
        if (iceState === "failed" || iceState === "disconnected") {
          void peer.getStats().then((stats) => {
            const candidatePairs: Array<Record<string, unknown>> = [];
            stats.forEach((report) => {
              if (report.type !== "candidate-pair" || candidatePairs.length >= 12) return;
              const pair = report as RTCStats & {
                localCandidateId?: string;
                remoteCandidateId?: string;
                state?: string;
                nominated?: boolean;
                selected?: boolean;
                protocol?: string;
                currentRoundTripTime?: number;
              };
              const localCandidate = pair.localCandidateId
                ? stats.get(pair.localCandidateId) as RTCStats & {
                    candidateType?: string;
                    relayProtocol?: string;
                  }
                : undefined;
              const remoteCandidate = pair.remoteCandidateId
                ? stats.get(pair.remoteCandidateId) as RTCStats & {
                    candidateType?: string;
                    relayProtocol?: string;
                  }
                : undefined;
              candidatePairs.push({
                state: pair.state,
                nominated: pair.nominated,
                selected: pair.selected,
                localType: localCandidate?.candidateType,
                remoteType: remoteCandidate?.candidateType,
                protocol: pair.protocol,
                relayProtocol: localCandidate?.relayProtocol ?? remoteCandidate?.relayProtocol,
                roundTripTime: pair.currentRoundTripTime,
              });
            });
            console.warn("[PingTalk calls] ICE candidate-pair diagnostics", {
              iceState,
              candidatePairs,
            });
          }).catch(() => {
            console.warn("[PingTalk calls] ICE statistics unavailable");
          });
        }
      };
      peersRef.current.set(remoteUserId, peer);
      return peer;
    },
    [sendSignal],
  );

  const emitWithAck = useCallback(
    (event: string, payload: object) =>
      new Promise<CallResponse>((resolve, reject) => {
        if (!socket?.connected) {
          reject(new Error("Realtime connection is unavailable. Try again shortly."));
          return;
        }
        socket.timeout(10_000).emit(
          event,
          payload,
          (timeoutError: Error | null, response: CallResponse) => {
            if (timeoutError) {
              reject(new Error("The server did not respond. Please try again."));
            } else if (!response?.ok) {
              reject(new Error(response?.error?.message ?? "The call request failed."));
            } else {
              resolve(response);
            }
          },
        );
      }),
    [socket],
  );

  const startCall = useCallback(
    async (conversationId: string, callType: CallType) => {
      if (
        callRef.current ||
        incomingCallRef.current ||
        callActionInProgressRef.current
      ) {
        return;
      }
      callActionInProgressRef.current = true;
      setError("");
      setStatus("Preparing call");
      try {
        await loadIceServers();
        await getLocalMedia(callType);
        const response = await emitWithAck("call:invite", {
          conversationId,
          callType,
        });
        if (!response.call) throw new Error("The server returned an invalid call.");
        callRef.current = response.call;
        setCall(response.call);
        setStatus("Ringing");
      } catch (reason) {
        stopMedia();
        setStatus("Idle");
        setError(getCallError(reason));
      } finally {
        callActionInProgressRef.current = false;
      }
    },
    [emitWithAck, getLocalMedia, loadIceServers, stopMedia],
  );

  const acceptCall = useCallback(async () => {
    const pendingCall = incomingCallRef.current ?? incomingCall;
    if (!pendingCall || callActionInProgressRef.current) return;
    callActionInProgressRef.current = true;
    stopIncomingAlerts(pendingCall.id);
    setError("");
    setStatus("Preparing call");
    try {
      await loadIceServers();
      await getLocalMedia(pendingCall.callType);
      callRef.current = pendingCall;
      const response = await emitWithAck("call:accept", {
        callId: pendingCall.id,
      });
      if (!response.call) throw new Error("The server returned an invalid call.");
      callRef.current = response.call;
      setCall(response.call);
      incomingCallRef.current = null;
      setIncomingCall(null);
      setStatus("Connecting");
    } catch (reason) {
      callRef.current = null;
      stopMedia();
      setStatus("Idle");
      setError(getCallError(reason));
    } finally {
      callActionInProgressRef.current = false;
    }
  }, [emitWithAck, getLocalMedia, incomingCall, loadIceServers, stopIncomingAlerts, stopMedia]);

  const rejectCall = useCallback(async () => {
    const rejected = incomingCallRef.current ?? incomingCall;
    if (!rejected) return;
    stopIncomingAlerts(rejected.id);
    incomingCallRef.current = null;
    setIncomingCall(null);
    try {
      await emitWithAck("call:reject", { callId: rejected.id });
    } catch (reason) {
      setError(getCallError(reason));
    }
  }, [emitWithAck, incomingCall, stopIncomingAlerts]);

  const cancelCall = useCallback(async () => {
    const currentCall = callRef.current;
    if (!currentCall) return;
    try {
      await emitWithAck("call:cancel", { callId: currentCall.id });
    } catch (reason) {
      setError(getCallError(reason));
    } finally {
      clearCall();
    }
  }, [clearCall, emitWithAck]);

  const leaveCall = useCallback(async () => {
    const currentCall = callRef.current;
    if (!currentCall) return;
    try {
      await emitWithAck("call:leave", { callId: currentCall.id });
    } catch (reason) {
      setError(getCallError(reason));
    } finally {
      clearCall();
    }
  }, [clearCall, emitWithAck]);

  const toggleMicrophone = useCallback(() => {
    const nextMuted = !muted;
    localStreamRef.current
      ?.getAudioTracks()
      .forEach((track) => (track.enabled = !nextMuted));
    setMuted(nextMuted);
  }, [muted]);

  const toggleCamera = useCallback(() => {
    const nextEnabled = !cameraEnabled;
    localStreamRef.current
      ?.getVideoTracks()
      .forEach((track) => (track.enabled = nextEnabled));
    setCameraEnabled(nextEnabled);
  }, [cameraEnabled]);

  const switchCamera = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream || !cameraEnabled || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === "videoinput",
      );
      if (cameras.length < 2) return;
      const currentDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId;
      const nextCamera =
        cameras.find((camera) => camera.deviceId !== currentDeviceId) ?? cameras[0];
      const cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: { exact: nextCamera.deviceId } },
      });
      const nextVideoTrack = cameraStream.getVideoTracks()[0];
      if (!nextVideoTrack) {
        cameraStream.getTracks().forEach((track) => track.stop());
        return;
      }

      for (const peer of peersRef.current.values()) {
        const sender = peer.getSenders().find((item) => item.track?.kind === "video");
        if (sender) await sender.replaceTrack(nextVideoTrack);
      }
      stream.getVideoTracks().forEach((track) => {
        stream.removeTrack(track);
        track.stop();
      });
      stream.addTrack(nextVideoTrack);
      localStreamRef.current = new MediaStream(stream.getTracks());
      setLocalStream(localStreamRef.current);
      cameraStream.getAudioTracks().forEach((track) => track.stop());
    } catch (reason) {
      setError(getCallError(reason));
    }
  }, [cameraEnabled]);

  useEffect(() => {
    if (!call) return;
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - call.startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [call]);

  useEffect(() => {
    if (!socket) return;

    const onIncoming = (payload: { call: ActiveCall }) => {
      if (
        payload.call.caller.id !== userId &&
        !callRef.current &&
        !incomingCallRef.current
      ) {
        incomingCallRef.current = payload.call;
        setIncomingCall(payload.call);
        startIncomingAlerts(payload.call);
      }
    };
    const onAccepted = (payload: { call: ActiveCall }) => {
      if (callRef.current?.id !== payload.call.id) return;
      setCall(payload.call);
      callRef.current = payload.call;
      setStatus("Connecting");
    };
    const onRejected = (payload: { callId: string; userId: string }) => {
      if (callRef.current?.id !== payload.callId) return;
      const updatedCall = {
        ...callRef.current,
        pendingUserIds: callRef.current.pendingUserIds.filter(
          (pendingUserId) => pendingUserId !== payload.userId,
        ),
      };
      callRef.current = updatedCall;
      setCall(updatedCall);
    };
    const onAcceptedElsewhere = (payload: { callId: string }) => {
      stopIncomingAlerts(payload.callId);
      if (incomingCallRef.current?.id === payload.callId) {
        incomingCallRef.current = null;
      }
      setIncomingCall((current) =>
        current?.id === payload.callId ? null : current,
      );
    };
    const onParticipantJoined = async (payload: {
      callId: string;
      participant: CallParticipant;
    }) => {
      const currentCall = callRef.current;
      const stream = localStreamRef.current;
      if (
        !currentCall ||
        currentCall.id !== payload.callId ||
        payload.participant.id === userId ||
        !stream ||
        peersRef.current.has(payload.participant.id)
      ) {
        return;
      }
      const nextCall = {
        ...currentCall,
        status: "active" as const,
        participants: currentCall.participants.some(
          (participant) => participant.id === payload.participant.id,
        )
          ? currentCall.participants
          : [...currentCall.participants, payload.participant],
      };
      callRef.current = nextCall;
      setCall(nextCall);
      const peer = createPeer(payload.participant.id);
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        sendSignal(payload.participant.id, "offer", {
          type: offer.type,
          sdp: offer.sdp,
        });
      } catch {
        setError("Unable to connect to a call participant.");
      }
    };
    const onSignal = async (payload: SignalMessage) => {
      const currentCall = callRef.current;
      if (!currentCall || currentCall.id !== payload.callId) return;
      try {
        const peer = createPeer(payload.fromUserId);
        if (payload.signalType === "offer") {
          await peer.setRemoteDescription(
            new RTCSessionDescription(parseSessionDescription(payload.data)),
          );
          for (const candidate of pendingIceRef.current.get(payload.fromUserId) ?? []) {
            await peer.addIceCandidate(new RTCIceCandidate(candidate));
          }
          pendingIceRef.current.delete(payload.fromUserId);
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          sendSignal(payload.fromUserId, "answer", {
            type: answer.type,
            sdp: answer.sdp,
          });
        } else if (payload.signalType === "answer") {
          await peer.setRemoteDescription(
            new RTCSessionDescription(parseSessionDescription(payload.data)),
          );
          for (const candidate of pendingIceRef.current.get(payload.fromUserId) ?? []) {
            await peer.addIceCandidate(new RTCIceCandidate(candidate));
          }
          pendingIceRef.current.delete(payload.fromUserId);
        } else {
          const candidate = parseIceCandidate(payload.data);
          if (peer.remoteDescription) {
            await peer.addIceCandidate(new RTCIceCandidate(candidate));
          } else {
            const pending = pendingIceRef.current.get(payload.fromUserId) ?? [];
            pending.push(candidate);
            pendingIceRef.current.set(payload.fromUserId, pending);
          }
        }
      } catch {
        setError("A call connection could not be established. Check your network and try again.");
      }
    };
    const onParticipantLeft = (payload: { callId: string; userId: string }) => {
      if (callRef.current?.id !== payload.callId) return;
      peersRef.current.get(payload.userId)?.close();
      peersRef.current.delete(payload.userId);
      pendingIceRef.current.delete(payload.userId);
      setRemoteStreams((current) => {
        const next = { ...current };
        delete next[payload.userId];
        return next;
      });
      setCall((current) =>
        current
          ? {
              ...current,
              participants: current.participants.filter(
                (participant) => participant.id !== payload.userId,
              ),
            }
          : current,
      );
    };
    const onCallEnded = (payload: { callId: string; reason: string }) => {
      stopIncomingAlerts(payload.callId);
      if (incomingCallRef.current?.id === payload.callId) {
        incomingCallRef.current = null;
        setIncomingCall(null);
        if (payload.reason === "no-answer") setError("No one answered the call.");
        return;
      }
      if (callRef.current?.id !== payload.callId) return;
      clearCall();
      if (payload.reason === "no-answer") setError("No one answered the call.");
      else if (payload.reason === "rejected") setError("The call was declined.");
    };
    const onCallCancelled = (payload: { callId: string }) => {
      stopIncomingAlerts(payload.callId);
      if (incomingCallRef.current?.id === payload.callId) {
        incomingCallRef.current = null;
      }
      setIncomingCall((current) =>
        current?.id === payload.callId ? null : current,
      );
      if (callRef.current?.id === payload.callId) clearCall();
    };
    const onSocketDisconnect = () => {
      stopIncomingAlerts();
      if (callRef.current) {
        clearCall();
        setError("The call ended because the realtime connection was lost.");
      } else if (incomingCallRef.current) {
        incomingCallRef.current = null;
        setIncomingCall(null);
      }
    };

    socket.on("call:incoming", onIncoming);
    socket.on("call:accepted", onAccepted);
    socket.on("call:rejected", onRejected);
    socket.on("call:accepted-elsewhere", onAcceptedElsewhere);
    socket.on("call:participant-joined", onParticipantJoined);
    socket.on("call:signal", onSignal);
    socket.on("call:participant-left", onParticipantLeft);
    socket.on("call:ended", onCallEnded);
    socket.on("call:cancelled", onCallCancelled);
    socket.on("disconnect", onSocketDisconnect);
    return () => {
      socket.off("call:incoming", onIncoming);
      socket.off("call:accepted", onAccepted);
      socket.off("call:rejected", onRejected);
      socket.off("call:accepted-elsewhere", onAcceptedElsewhere);
      socket.off("call:participant-joined", onParticipantJoined);
      socket.off("call:signal", onSignal);
      socket.off("call:participant-left", onParticipantLeft);
      socket.off("call:ended", onCallEnded);
      socket.off("call:cancelled", onCallCancelled);
      socket.off("disconnect", onSocketDisconnect);
      stopIncomingAlerts();
      clearCall();
    };
  }, [
    clearCall,
    createPeer,
    sendSignal,
    socket,
    startIncomingAlerts,
    stopIncomingAlerts,
    userId,
  ]);

  return {
    currentUserId: userId,
    incomingCall,
    call,
    status,
    error,
    localStream,
    remoteStreams,
    muted,
    cameraEnabled,
    elapsedSeconds,
    soundEnabled,
    soundError,
    notificationPermission,
    enableCallSound,
    requestCallNotifications,
    startCall,
    acceptCall,
    rejectCall,
    cancelCall,
    leaveCall,
    toggleMicrophone,
    toggleCamera,
    switchCamera,
    clearError: () => setError(""),
  };
}
