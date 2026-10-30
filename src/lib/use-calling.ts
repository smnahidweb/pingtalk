"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";

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

  const callRef = useRef(call);
  const incomingCallRef = useRef(incomingCall);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const pendingIceRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const callActionInProgressRef = useRef(false);

  useEffect(() => {
    callRef.current = call;
    incomingCallRef.current = incomingCall;
  }, [call, incomingCall]);

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
      socket.emit("call:signal", {
        callId: currentCall.id,
        toUserId,
        signalType,
        data,
      });
    },
    [socket],
  );

  const createPeer = useCallback(
    (remoteUserId: string) => {
      const existing = peersRef.current.get(remoteUserId);
      if (existing) return existing;

      const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const stream = localStreamRef.current;
      stream?.getTracks().forEach((track) => peer.addTrack(track, stream));
      peer.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal(remoteUserId, "ice", event.candidate.toJSON());
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
        } else if (
          peer.connectionState === "connecting" ||
          peer.connectionState === "disconnected"
        ) {
          setStatus("Reconnecting");
        } else if (peer.connectionState === "failed") {
          setStatus("Connection failed");
        }
      };
      peer.oniceconnectionstatechange = () => {
        if (peer.iceConnectionState === "failed") {
          setStatus("Connection failed");
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
    [emitWithAck, getLocalMedia, stopMedia],
  );

  const acceptCall = useCallback(async () => {
    const pendingCall = incomingCallRef.current ?? incomingCall;
    if (!pendingCall || callActionInProgressRef.current) return;
    callActionInProgressRef.current = true;
    setError("");
    setStatus("Preparing call");
    try {
      await getLocalMedia(pendingCall.callType);
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
      stopMedia();
      setStatus("Idle");
      setError(getCallError(reason));
    } finally {
      callActionInProgressRef.current = false;
    }
  }, [emitWithAck, getLocalMedia, incomingCall, stopMedia]);

  const rejectCall = useCallback(async () => {
    if (!incomingCall) return;
    const rejected = incomingCall;
    incomingCallRef.current = null;
    setIncomingCall(null);
    try {
      await emitWithAck("call:reject", { callId: rejected.id });
    } catch (reason) {
      setError(getCallError(reason));
    }
  }, [emitWithAck, incomingCall]);

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
      }
    };
    const onAccepted = (payload: { call: ActiveCall }) => {
      if (callRef.current?.id !== payload.call.id) return;
      setCall(payload.call);
      callRef.current = payload.call;
      setStatus("Connecting");
    };
    const onAcceptedElsewhere = (payload: { callId: string }) => {
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
      if (incomingCallRef.current?.id === payload.callId) {
        incomingCallRef.current = null;
      }
      setIncomingCall((current) =>
        current?.id === payload.callId ? null : current,
      );
      if (callRef.current?.id === payload.callId) clearCall();
    };
    const onSocketDisconnect = () => {
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
      socket.off("call:accepted-elsewhere", onAcceptedElsewhere);
      socket.off("call:participant-joined", onParticipantJoined);
      socket.off("call:signal", onSignal);
      socket.off("call:participant-left", onParticipantLeft);
      socket.off("call:ended", onCallEnded);
      socket.off("call:cancelled", onCallCancelled);
      socket.off("disconnect", onSocketDisconnect);
      clearCall();
    };
  }, [clearCall, createPeer, sendSignal, socket, userId]);

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
