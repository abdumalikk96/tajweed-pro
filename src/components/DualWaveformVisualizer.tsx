'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { trimSilence } from '@/lib/audioUtils';

export interface DualWaveformVisualizerProps {
  /** Ссылка на эталонное аудио шейха */
  referenceAudioUrl?: string;
  /** Список ссылок на эталонные аудио (для диапазона аятов или всей страницы) */
  referenceAudioUrls?: string[];
  /** Динамическая подпись текущего объекта эталона (Слово / Аят / Диапазон / Страница) */
  referenceLabel?: string;
  /** Компактный режим для закрепленной нижней панели (Sticky Control Dock) */
  compact?: boolean;
  /** Идет ли сейчас запись (показываем индикатор поверх эталона) */
  isRecording: boolean;
  /** Готовая запись ученика (PCM Float32Array) — приоритетный источник */
  userAudioBuffer?: Float32Array | null;
  /** Частота дискретизации userAudioBuffer (по умолчанию 16000) */
  userSampleRate?: number;
  /** Запасной источник: URL готовой записи ученика (blob:/wav) */
  userAudioUrl?: string | null;
  className?: string;
}

interface TrimmedPcm {
  pcm: Float32Array;
  sampleRate: number;
  durationMs: number;
}

const NUM_BARS = 64;
const TRIM_THRESHOLD_RMS = 0.012;
const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 96;

function getAudioContextClass(): typeof AudioContext {
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext
  );
}

/** Декодирует аудио по URL (сначала через /api/audio-proxy для обхода CORS, затем напрямую). */
async function fetchAndDecode(url: string): Promise<AudioBuffer | null> {
  const candidates =
    url.startsWith('blob:') || url.startsWith('data:')
      ? [url]
      : [`/api/audio-proxy?url=${encodeURIComponent(url)}`, url];

  for (const candidate of candidates) {
    try {
      const resp = await fetch(candidate);
      if (!resp.ok) continue;
      const arrayBuffer = await resp.arrayBuffer();
      if (arrayBuffer.byteLength < 100) continue;

      const ctx = new (getAudioContextClass())();
      try {
        return await ctx.decodeAudioData(arrayBuffer);
      } finally {
        ctx.close().catch(() => {});
      }
    } catch {
      // пробуем следующий источник
    }
  }
  return null;
}

/** Обрезает тишину в начале и конце, чтобы оба слова начинались с одной точки. */
function trimToSpeech(pcm: Float32Array, sampleRate: number): TrimmedPcm | null {
  if (!pcm || pcm.length === 0) return null;
  const { trimmedBuffer } = trimSilence(pcm, sampleRate, TRIM_THRESHOLD_RMS);
  const finalPcm = trimmedBuffer.length > 0 ? trimmedBuffer : pcm;
  return {
    pcm: finalPcm,
    sampleRate,
    durationMs: (finalPcm.length / sampleRate) * 1000,
  };
}

/**
 * Считает ровно NUM_BARS амплитудных пиков во временной области на ОБЩЕЙ временной шкале
 * (binMs одинаковый для шейха и ученика), чтобы была видна разница в длительности.
 * Значения нормализуются к собственному максимуму (0..1).
 */
function computeTimeDomainPeaks(
  source: TrimmedPcm,
  binMs: number,
  numBars = NUM_BARS
): number[] {
  const samplesPerBin = Math.max(1, Math.floor((binMs / 1000) * source.sampleRate));
  const raw: number[] = [];
  let maxVal = 0;

  for (let i = 0; i < numBars; i++) {
    const start = i * samplesPerBin;
    if (start >= source.pcm.length) {
      raw.push(0);
      continue;
    }
    const end = Math.min(source.pcm.length, start + samplesPerBin);
    let localPeak = 0;
    let sumSq = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(source.pcm[j]);
      if (v > localPeak) localPeak = v;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, end - start));
    const combined = localPeak * 0.65 + rms * 0.35;
    raw.push(combined);
    if (combined > maxVal) maxVal = combined;
  }

  if (maxVal <= 1e-6) return raw.map(() => 0);
  return raw.map((v) => Math.min(1, v / maxVal));
}

function drawRoundedBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, [Math.min(3, w / 2)]);
  } else {
    ctx.rect(x, y, w, h);
  }
  ctx.fill();
}

export default function DualWaveformVisualizer({
  referenceAudioUrl,
  referenceAudioUrls,
  referenceLabel,
  compact = false,
  isRecording,
  userAudioBuffer,
  userSampleRate = 16000,
  userAudioUrl,
  className,
}: DualWaveformVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [refTrimmed, setRefTrimmed] = useState<TrimmedPcm | null>(null);
  const [userTrimmed, setUserTrimmed] = useState<TrimmedPcm | null>(null);

  const effectiveUrlsKey = useMemo(() => {
    if (referenceAudioUrls && referenceAudioUrls.length > 0) {
      return referenceAudioUrls.filter(Boolean).join('|');
    }
    return referenceAudioUrl || '';
  }, [referenceAudioUrl, referenceAudioUrls]);

  // 1. Эталон шейха: декодирование одного или нескольких URL + обрезка тишины
  useEffect(() => {
    let cancelled = false;
    setRefTrimmed(null);
    const urls = effectiveUrlsKey ? effectiveUrlsKey.split('|').filter(Boolean) : [];
    if (urls.length === 0) return;

    (async () => {
      const targetUrls = urls.slice(0, 12);
      const decodedList = await Promise.all(
        targetUrls.map((u) => fetchAndDecode(u))
      );
      if (cancelled) return;

      const validTrimmed: TrimmedPcm[] = [];
      for (const decoded of decodedList) {
        if (!decoded) continue;
        const ch0 = decoded.getChannelData(0);
        const copy = new Float32Array(ch0.length);
        copy.set(ch0);
        const trimmed = trimToSpeech(copy, decoded.sampleRate);
        if (trimmed && trimmed.pcm.length > 0) {
          validTrimmed.push(trimmed);
        }
      }

      if (cancelled || validTrimmed.length === 0) return;

      if (validTrimmed.length === 1) {
        setRefTrimmed(validTrimmed[0]);
        return;
      }

      const baseSr = validTrimmed[0].sampleRate;
      const totalSamples = validTrimmed.reduce((acc, item) => acc + item.pcm.length, 0);
      const totalDurationMs = validTrimmed.reduce(
        (acc, item) => acc + item.durationMs,
        0
      );
      const mergedPcm = new Float32Array(totalSamples);
      let offset = 0;
      for (const item of validTrimmed) {
        mergedPcm.set(item.pcm, offset);
        offset += item.pcm.length;
      }

      if (!cancelled) {
        setRefTrimmed({
          pcm: mergedPcm,
          sampleRate: baseSr,
          durationMs: totalDurationMs,
        });
      }
    })().catch((err) =>
      console.warn('[DualWaveform] Не удалось декодировать эталон шейха:', err)
    );

    return () => {
      cancelled = true;
    };
  }, [effectiveUrlsKey]);

  // 2. Готовая запись ученика: декодирование ПОСЛЕ окончания записи + обрезка тишины
  useEffect(() => {
    let cancelled = false;

    // Во время новой записи или при отсутствии данных — очищаем предыдущую зеленую волну
    if (isRecording || (!userAudioBuffer && !userAudioUrl)) {
      setUserTrimmed(null);
      return;
    }

    if (userAudioBuffer && userAudioBuffer.length > 0) {
      setUserTrimmed(trimToSpeech(userAudioBuffer, userSampleRate));
      return;
    }

    if (userAudioUrl) {
      (async () => {
        const decoded = await fetchAndDecode(userAudioUrl);
        if (cancelled || !decoded) return;
        const ch0 = decoded.getChannelData(0);
        const copy = new Float32Array(ch0.length);
        copy.set(ch0);
        const trimmed = trimToSpeech(copy, decoded.sampleRate);
        if (!cancelled) setUserTrimmed(trimmed);
      })().catch((err) =>
        console.warn('[DualWaveform] Не удалось декодировать запись ученика:', err)
      );
    }

    return () => {
      cancelled = true;
    };
  }, [isRecording, userAudioBuffer, userAudioUrl, userSampleRate]);

  // 3. Общая временная шкала: самая длинная из двух записей занимает всю ширину
  const { refPeaks, userPeaks } = useMemo(() => {
    const totalMs = Math.max(
      refTrimmed?.durationMs ?? 0,
      userTrimmed?.durationMs ?? 0,
      1
    );
    const binMs = totalMs / NUM_BARS;
    return {
      refPeaks: refTrimmed ? computeTimeDomainPeaks(refTrimmed, binMs) : null,
      userPeaks: userTrimmed ? computeTimeDomainPeaks(userTrimmed, binMs) : null,
    };
  }, [refTrimmed, userTrimmed]);

  // 4. Статичная отрисовка наложения на Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const half = height / 2;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#080d1a';
    ctx.fillRect(0, 0, width, height);

    // Центральная ось
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, half);
    ctx.lineTo(width, half);
    ctx.stroke();
    ctx.setLineDash([]);

    const gap = 3;
    const barWidth = Math.max(2, (width - (NUM_BARS - 1) * gap) / NUM_BARS);
    const maxBarHalf = half - 4;

    for (let i = 0; i < NUM_BARS; i++) {
      const x = i * (barWidth + gap);

      // Задний план: эталон шейха (#1A6B8A бирюзово-синий)
      if (refPeaks) {
        const v = refPeaks[i];
        if (v > 0.01) {
          const h = Math.max(3, v * maxBarHalf);
          ctx.fillStyle = 'rgba(26, 107, 138, 0.85)';
          drawRoundedBar(ctx, x, half - h, barWidth, h * 2);
        }
      } else {
        // Плейсхолдер, пока эталон загружается
        ctx.fillStyle = 'rgba(26, 107, 138, 0.25)';
        drawRoundedBar(ctx, x, half - 3, barWidth, 6);
      }

      // Передний план: запись ученика (emerald-500 / 75%), более узкий столбик по центру,
      // чтобы синий эталон оставался виден по бокам даже при более громком голосе
      if (userPeaks) {
        const v = userPeaks[i];
        if (v > 0.01) {
          const h = Math.max(3, v * maxBarHalf);
          const innerW = Math.max(1.5, barWidth * 0.55);
          const innerX = x + (barWidth - innerW) / 2;
          ctx.fillStyle = 'rgba(16, 185, 129, 0.75)';
          drawRoundedBar(ctx, innerX, half - h, innerW, h * 2);
        }
      }
    }
  }, [refPeaks, userPeaks]);

  const refSec = refTrimmed ? (refTrimmed.durationMs / 1000).toFixed(2) : null;
  const userSec = userTrimmed ? (userTrimmed.durationMs / 1000).toFixed(2) : null;

  return (
    <div
      className={cn(
        'w-full rounded-2xl bg-[#0B0F17] border border-[#52437A]/70 shadow-inner',
        compact ? 'p-2.5 space-y-1.5' : 'p-3 space-y-2.5',
        className
      )}
    >
      {/* Легенда */}
      <div className="flex items-center justify-between text-[11px] px-1 select-none gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="w-2.5 h-2.5 rounded-full bg-[#1A6B8A] shrink-0" />
          <span className="text-sky-400 font-medium truncate">
            {referenceLabel || 'Sheikh Namuna (Etalon)'}
            {refSec && <span className="text-slate-400 ml-1.5 font-mono">{refSec} s</span>}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={cn(
              'w-2.5 h-2.5 rounded-full',
              userTrimmed ? 'bg-emerald-400' : 'bg-emerald-500/30'
            )}
          />
          <span
            className={cn(
              'font-medium',
              userTrimmed ? 'text-emerald-300' : 'text-slate-400'
            )}
          >
            Sizning ovozingiz (Natija)
            {userSec && <span className="text-slate-400 ml-1">{userSec} s</span>}
          </span>
        </div>
      </div>

      {/* Canvas с наложением */}
      <div
        className={cn(
          'w-full rounded-xl overflow-hidden border border-[#52437A]/50 bg-[#0B0F17] relative',
          compact ? 'h-14 sm:h-16' : 'h-24'
        )}
      >
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          className="w-full h-full block"
        />

        {isRecording && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-slate-950/30">
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-rose-500/15 border border-rose-500/40 text-xs font-semibold text-rose-300">
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
              <span>🔴 Ovoz yozilmoqda...</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
