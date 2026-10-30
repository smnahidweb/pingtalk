"use client";

import { useEffect, useRef, useState } from "react";
import {
  Camera,
  CameraOff,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  SwitchCamera,
  Video,
  Volume2,
  X,
} from "lucide-react";
import type { useCalling } from "@/lib/use-calling";

type CallingState = ReturnType<typeof useCalling>;

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function VideoTile({
  name,
  stream,
  muted = false,
  local = false,
}: {
  name: string;
  stream?: MediaStream;
  muted?: boolean;
  local?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream ?? null;
  }, [stream]);

  const hasVideo = Boolean(stream?.getVideoTracks().some((track) => track.enabled));
  return (
    <div className={`call-tile ${local ? "call-tile--local" : ""}`}>
      {stream && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={muted}
          className={hasVideo ? "call-tile__video" : "call-tile__video is-hidden"}
        />
      )}
      {!hasVideo && (
        <span className="call-tile__avatar" aria-hidden="true">
          {initials(name)}
        </span>
      )}
      <span className="call-tile__name">
        {name}{local ? " (You)" : ""}
      </span>
    </div>
  );
}

export default function CallingUI({
  calling,
}: {
  calling: CallingState;
}) {
  const {
    incomingCall,
    call,
    status,
    error,
    localStream,
    remoteStreams,
    muted,
    cameraEnabled,
    elapsedSeconds,
    acceptCall,
    rejectCall,
    cancelCall,
    leaveCall,
    toggleMicrophone,
    toggleCamera,
    switchCamera,
    clearError,
  } = calling;

  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedOutputId, setSelectedOutputId] = useState("");
  const [outputError, setOutputError] = useState("");
  const outputSelectionSupported =
    typeof HTMLMediaElement !== "undefined" &&
    typeof (
      HTMLMediaElement.prototype as HTMLMediaElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
      }
    ).setSinkId === "function";
  const activeParticipants = call?.participants.filter(
    (participant) => participant.id !== calling.currentUserId,
  ) ?? [];

  useEffect(() => {
    if (!call || !navigator.mediaDevices?.enumerateDevices) return;
    const refreshDevices = () => {
      void navigator.mediaDevices.enumerateDevices().then((devices) => {
        const outputs = devices.filter((device) => device.kind === "audiooutput");
        setAudioOutputs(outputs);
        setSelectedOutputId((current) => current || outputs[0]?.deviceId || "");
      }).catch(() => {
        setOutputError("Unable to list available speakers.");
      });
    };
    refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
    };
  }, [call]);

  async function changeAudioOutput(deviceId: string) {
    setSelectedOutputId(deviceId);
    const mediaElements = Array.from(
      document.querySelectorAll<HTMLMediaElement>(".call-tile__video"),
    );
    const elementsWithOutputSelection = mediaElements as Array<
      HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> }
    >;
    const supportedElements = elementsWithOutputSelection.filter(
      (element) => typeof element.setSinkId === "function",
    );
    try {
      await Promise.all(
        supportedElements.map((element) => element.setSinkId?.(deviceId)),
      );
    } catch {
      setOutputError("Unable to switch speaker output.");
    }
  }

  if (!call && !incomingCall && !error) return null;

  const minutes = Math.floor(elapsedSeconds / 60).toString().padStart(2, "0");
  const seconds = (elapsedSeconds % 60).toString().padStart(2, "0");

  return (
    <>
      {incomingCall && !call && (
        <div className="call-overlay" role="presentation">
          <section
            className="call-card call-card--incoming"
            role="dialog"
            aria-modal="true"
            aria-labelledby="incoming-call-title"
          >
            <button
              className="call-card__close"
              onClick={() => void rejectCall()}
              aria-label="Dismiss incoming call"
            >
              <X size={19} />
            </button>
            <span className="call-card__eyebrow">INCOMING {incomingCall.callType} CALL</span>
            <span className="call-card__avatar" aria-hidden="true">
              {initials(incomingCall.caller.name)}
            </span>
            <h2 id="incoming-call-title">{incomingCall.caller.name}</h2>
            <p>
              {incomingCall.mode === "GROUP"
                ? `Group call · ${incomingCall.conversationName}`
                : "PingTalk call"}
            </p>
            <div className="call-card__actions">
              <button
                type="button"
                className="call-control call-control--danger"
                onClick={() => void rejectCall()}
                aria-label="Decline call"
              >
                <PhoneOff size={20} />
                <span>Decline</span>
              </button>
              <button
                type="button"
                className="call-control call-control--accept"
                onClick={() => void acceptCall()}
                aria-label="Accept call"
              >
                <Phone size={20} />
                <span>Accept</span>
              </button>
            </div>
            {error && <p className="call-card__error" role="alert">{error}</p>}
          </section>
        </div>
      )}

      {call && (
        <div className="call-overlay" role="presentation">
          <section
            className="call-stage"
            role="dialog"
            aria-modal="true"
            aria-label={`${call.callType.toLowerCase()} call`}
          >
            <header className="call-stage__header">
              <div>
                <span className="call-stage__eyebrow">
                  {call.mode === "GROUP" ? "GROUP CALL" : `${call.callType} CALL`}
                </span>
                <h2>{status === "Ringing" ? "Calling…" : status}</h2>
              </div>
              <span className="call-stage__duration">
                {call.participants.length > 1 ? `${minutes}:${seconds}` : "Waiting for answer"}
              </span>
            </header>
            <div
              className={`call-grid ${call.callType === "AUDIO" ? "call-grid--audio" : ""}`}
              aria-live="polite"
            >
              <VideoTile
                name="You"
                stream={localStream ?? undefined}
                muted
                local
              />
              {activeParticipants.map((participant) => (
                  <VideoTile
                    key={participant.id}
                    name={participant.name}
                    stream={remoteStreams[participant.id]}
                  />
              ))}
            </div>
            <footer className="call-stage__controls">
              <button
                type="button"
                className={`call-control ${muted ? "is-active" : ""}`}
                onClick={toggleMicrophone}
                aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              >
                {muted ? <MicOff size={20} /> : <Mic size={20} />}
                <span>{muted ? "Unmute" : "Mute"}</span>
              </button>
              {call.callType === "VIDEO" && (
                <button
                  type="button"
                  className={`call-control ${!cameraEnabled ? "is-active" : ""}`}
                  onClick={toggleCamera}
                  aria-label={cameraEnabled ? "Turn camera off" : "Turn camera on"}
                >
                  {cameraEnabled ? <Camera size={20} /> : <CameraOff size={20} />}
                  <span>{cameraEnabled ? "Camera" : "Camera off"}</span>
                </button>
              )}
              {call.callType === "VIDEO" && cameraEnabled && (
                <button
                  type="button"
                  className="call-control"
                  onClick={() => void switchCamera()}
                  aria-label="Switch camera"
                >
                  <SwitchCamera size={20} />
                  <span>Flip</span>
                </button>
              )}
              {outputSelectionSupported && audioOutputs.length > 0 && (
                <label className="call-output-control">
                  <Volume2 size={17} />
                  <span className="visually-hidden">Speaker output</span>
                  <select
                    value={selectedOutputId}
                    onChange={(event) => void changeAudioOutput(event.target.value)}
                    aria-label="Speaker output"
                  >
                    {audioOutputs.map((device, index) => (
                      <option key={device.deviceId || device.label} value={device.deviceId}>
                        {device.label || `Speaker ${index + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {call.status === "ringing" ? (
                <button
                  type="button"
                  className="call-control call-control--danger"
                  onClick={() => void cancelCall()}
                  aria-label="Cancel call"
                >
                  <PhoneOff size={20} />
                  <span>Cancel</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="call-control call-control--danger"
                  onClick={() => void leaveCall()}
                  aria-label="End call"
                >
                  <PhoneOff size={20} />
                  <span>End call</span>
                </button>
              )}
              {call.callType === "VIDEO" && <Video className="call-stage__video-indicator" size={18} />}
            </footer>
            {outputError && <p className="call-output-error" role="status">{outputError}</p>}
          </section>
        </div>
      )}

      {error && !call && !incomingCall && (
        <div className="call-error-toast" role="alert">
          <span>{error}</span>
          <button type="button" onClick={clearError} aria-label="Dismiss call message">
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}
