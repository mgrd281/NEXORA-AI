'use client';

import { useEffect, useState } from 'react';

/**
 * Live microphone level (0…1) from a MediaStream, measured as the RMS of the waveform with a
 * Web Audio AnalyserNode. Fast attack, slower release, so the Presence ring follows speech
 * without flicker. Returns 0 when there is no stream.
 */
export function useMicLevel(stream: MediaStream | null): number {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!stream) return;
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    let smoothed = 0;
    let shown = 0;
    let frame = 0;

    const tick = () => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (const v of buffer) sum += v * v;
      const rms = Math.sqrt(sum / buffer.length);
      // Speech RMS is typically 0.01–0.2; map that range onto 0–1 perceptually.
      const target = Math.min(1, Math.max(0, (Math.log10(rms + 1e-4) + 3.2) / 2.4));
      smoothed =
        target > smoothed
          ? smoothed + (target - smoothed) * 0.5
          : smoothed + (target - smoothed) * 0.12;
      if (Math.abs(smoothed - shown) > 0.02) {
        shown = smoothed;
        setLevel(Math.round(smoothed * 100) / 100);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      void ctx.close();
    };
  }, [stream]);

  return stream ? level : 0;
}
