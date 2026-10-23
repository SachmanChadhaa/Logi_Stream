"use client";

// Screen observer, browser side (CLAUDE_CODE_BRIEF step 5).
//
// What it does, and the guarantees it keeps:
//   * starts ONLY from a user click, through the browser's own getDisplayMedia
//     picker -- the student chooses the window (their IDE or terminal)
//   * state is the real capture state: if the student stops sharing from the
//     browser's own bar, the track ends and this goes back to "off"
//   * frames are downscaled here (max 1024 px wide, JPEG) and sampled about
//     every 15 s plus on Run/error; near-identical frames are skipped
//   * one frame in flight at a time; nothing is stored in the browser
//   * frames go to the gateway -> orchestrator -> LOCAL Ollama, and only a short
//     text observation comes back. "observer unavailable" never stops tutoring.

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "./api";
import type { SessionView } from "./types";

export type CaptureState = "off" | "starting" | "on" | "paused";

const SAMPLE_MS = 15_000;
const MAX_WIDTH = 1024;
const JPEG_QUALITY = 0.6;
// mean absolute difference on a 32x18 grey thumbnail, 0..255
const SAME_FRAME_THRESHOLD = 2.5;

function thumb(video: HTMLVideoElement): Uint8Array | null {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 18;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, 32, 18);
  const d = ctx.getImageData(0, 0, 32, 18).data;
  const g = new Uint8Array(32 * 18);
  for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  return g;
}

function difference(a: Uint8Array, b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

function frameB64(video: HTMLVideoElement): string | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const scale = Math.min(1, MAX_WIDTH / w);
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/jpeg", JPEG_QUALITY);
  return url.slice(url.indexOf(",") + 1);
}

export function useScreenObserver({
  problemId,
  codeRevision,
  canSend,
  onView,
}: {
  problemId: string;
  codeRevision: number;
  /** false while a tutor turn is running: an observation would only be skipped */
  canSend: boolean;
  onView: (v: SessionView) => void;
}) {
  const [state, setState] = useState<CaptureState>("off");
  const [status, setStatus] = useState<string>("observer off");
  const [unavailable, setUnavailable] = useState(false);
  const [lastObservedAt, setLastObservedAt] = useState<number | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastThumb = useRef<Uint8Array | null>(null);
  const inFlight = useRef(false);
  const stateRef = useRef<CaptureState>("off");
  const revRef = useRef(codeRevision);
  const canSendRef = useRef(canSend);
  revRef.current = codeRevision;
  canSendRef.current = canSend;

  const set = (s: CaptureState) => {
    stateRef.current = s;
    setState(s);
  };

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    videoRef.current = null;
    lastThumb.current = null;
    set("off");
    setStatus("observer off");
  }, []);

  const sample = useCallback(
    async (trigger: "interval" | "run" | "error" | "manual") => {
      const video = videoRef.current;
      if (stateRef.current !== "on" || !video || inFlight.current || !canSendRef.current) return;
      const t = thumb(video);
      if (t && lastThumb.current && trigger === "interval" &&
          difference(t, lastThumb.current) < SAME_FRAME_THRESHOLD) {
        return; // nothing changed on screen; save the GPU
      }
      const b64 = frameB64(video);
      if (!b64) return;
      inFlight.current = true;
      setStatus("looking at your screen…");
      try {
        const v = await api.observe(problemId, b64, trigger, revRef.current);
        lastThumb.current = t;
        setUnavailable(false);
        setLastObservedAt(Date.now());
        setStatus("observer on");
        onView(v);
      } catch (e) {
        if (e instanceof ApiError && e.status === 503) {
          setUnavailable(true);
          setStatus(e.message);
        } else if (e instanceof ApiError && (e.status === 409 || e.status === 429)) {
          setStatus("observer on (skipped a busy moment)");
        } else {
          setStatus(e instanceof ApiError ? e.message : String(e));
        }
      } finally {
        inFlight.current = false;
      }
    },
    [problemId, onView],
  );

  const start = useCallback(async () => {
    if (stateRef.current !== "off") return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setStatus("this browser cannot share a screen");
      return;
    }
    set("starting");
    setStatus("choose the window to share…");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 },
        audio: false,
      });
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      streamRef.current = stream;
      videoRef.current = video;
      // the student can stop sharing from the browser's own bar
      stream.getVideoTracks()[0]?.addEventListener("ended", stop);
      set("on");
      setStatus("observer on");
      setTimeout(() => sample("manual"), 500);
    } catch {
      set("off");
      setStatus("screen sharing was cancelled");
    }
  }, [sample, stop]);

  const pause = useCallback(() => {
    if (stateRef.current === "on") {
      set("paused");
      setStatus("observer paused");
    }
  }, []);

  const resume = useCallback(() => {
    if (stateRef.current === "paused" && streamRef.current) {
      set("on");
      setStatus("observer on");
    }
  }, []);

  useEffect(() => {
    const id = setInterval(() => sample("interval"), SAMPLE_MS);
    return () => clearInterval(id);
  }, [sample]);

  // never leave a capture running after the session view goes away
  useEffect(() => stop, [stop]);

  return { state, status, unavailable, lastObservedAt, start, stop, pause, resume, sample };
}
