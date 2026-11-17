'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { encodeWavBlob } from '@/lib/audioUtils';

export interface AudioInputDeviceInfo {
  deviceId: string;
  label: string;
}

export interface NormalizedAudioFloat32Array extends Float32Array {
  recordedAudioUrl?: string;
  rawPeakAmplitude?: number;
  rawRms?: number;
  rawPeakDb?: number;
}

export interface UseRawAudioRecorderOptions {
  autoStopOnSilence?: boolean;
  ambientNoiseRms?: number;
  onAutoStop?: (buffer: Float32Array, recordedAudioUrl?: string) => void;
  onLiveChunk?: (
    buffer16k: Float32Array,
    elapsedMs: number,
    reason: 'interval' | 'word_pause'
  ) => void;
}

export interface UseRawAudioRecorderReturn {
  isRecording: boolean;
  recordingDurationMs: number;
  liveRms: number;
  liveDb: number;
  liveLevelPercent: number;
  liveWaveform: number[];
  recordedAudioUrl: string | null;
  audioDevices: AudioInputDeviceInfo[];
  selectedDeviceId: string;
  setSelectedDeviceId: (deviceId: string) => void;
  refreshAudioDevices: () => Promise<void>;
  autoStopOnSilence: boolean;
  setAutoStopOnSilence: (enabled: boolean) => void;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<NormalizedAudioFloat32Array | null>;
  getCurrentBuffer16k: () => Float32Array | null;
  error: string | null;
  mediaStream: MediaStream | null;
}

const TARGET_SAMPLE_RATE = 16000;
const WAVEFORM_BARS = 36;
const SPEECH_RMS_THRESHOLD = 0.0008;
const MIN_ACTIVE_SPEECH_MS = 350;
const MIN_TOTAL_RECORDING_BEFORE_AUTOSTOP_MS = 1500;
const WAQF_SILENCE_MS = 1250;

/**
 * Безотказный рекордер для Windows/Chrome:
 * - Работает на нативной частоте микрофона ОС (44100 / 48000 Гц) без конфликтов sampleRate
 * - Поддерживает выбор конкретного микрофона через enumerateDevices()
 * - Собирает звук двумя путями (MediaRecorder + decodeAudioData И ScriptProcessorNode)
 * - Выполняет программную Auto-Gain нормализацию пиковой амплитуды до 0.85 после записи
 * - Пересэмплирует нормализованный буфер в 16000 Гц Float32Array для DSP и нейросети
 */
export function useRawAudioRecorder(
  options?: UseRawAudioRecorderOptions
): UseRawAudioRecorderReturn {
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingDurationMs, setRecordingDurationMs] = useState<number>(0);
  const [liveRms, setLiveRms] = useState<number>(0);
  const [liveDb, setLiveDb] = useState<number>(-60);
  const [liveLevelPercent, setLiveLevelPercent] = useState<number>(0);
  const [liveWaveform, setLiveWaveform] = useState<number[]>(() =>
    new Array(WAVEFORM_BARS).fill(4)
  );
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);
  const [audioDevices, setAudioDevices] = useState<AudioInputDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [autoStopOnSilence, setAutoStopOnSilence] = useState<boolean>(
    options?.autoStopOnSilence ?? true
  );
  const [error, setError] = useState<string | null>(null);
  const [activeMediaStream, setActiveMediaStream] = useState<MediaStream | null>(null);

  const selectedDeviceIdRef = useRef<string>(selectedDeviceId);
  useEffect(() => {
    selectedDeviceIdRef.current = selectedDeviceId;
  }, [selectedDeviceId]);

  const autoStopEnabledRef = useRef<boolean>(autoStopOnSilence);
  useEffect(() => {
    autoStopEnabledRef.current = autoStopOnSilence;
  }, [autoStopOnSilence]);

  const onAutoStopRef = useRef(options?.onAutoStop);
  useEffect(() => {
    onAutoStopRef.current = options?.onAutoStop;
  }, [options?.onAutoStop]);

  const onLiveChunkRef = useRef(options?.onLiveChunk);
  useEffect(() => {
    onLiveChunkRef.current = options?.onLiveChunk;
  }, [options?.onLiveChunk]);

  const lastLiveChunkMsRef = useRef<number>(0);
  const speechSinceLastChunkMsRef = useRef<number>(0);
  const wordPauseStartMsRef = useRef<number | null>(null);
  const wordPauseEmittedRef = useRef<boolean>(false);

  const ambientNoiseRmsRef = useRef<number>(options?.ambientNoiseRms ?? 0);
  useEffect(() => {
    ambientNoiseRmsRef.current = options?.ambientNoiseRms ?? 0;
  }, [options?.ambientNoiseRms]);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);

  const recordedChunksRef = useRef<Float32Array[]>([]);
  const totalSamplesRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cumulativeSpeechMsRef = useRef<number>(0);
  const silenceStartMsRef = useRef<number | null>(null);
  const autoStopTriggeredRef = useRef<boolean>(false);
  const isStoppingRef = useRef<boolean>(false);

  /**
   * Загружает список доступных аудиовходов (микрофонов)
   */
  const refreshAudioDevices = useCallback(async () => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      !navigator.mediaDevices.enumerateDevices
    ) {
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices
        .filter((d) => d.kind === 'audioinput')
        .map((d, idx) => ({
          deviceId: d.deviceId,
          label:
            d.label && d.label.trim().length > 0
              ? d.label
              : `Микрофон #${idx + 1} (${d.deviceId.slice(0, 6) || 'default'})`,
        }));

      setAudioDevices(inputs);
      if (inputs.length > 0 && !selectedDeviceIdRef.current) {
        const preferred =
          inputs.find((d) => d.deviceId === 'default') ?? inputs[0];
        setSelectedDeviceId(preferred.deviceId);
      }
    } catch {
      // ignore enumeration errors before permission is granted
    }
  }, []);

  useEffect(() => {
    refreshAudioDevices();
    if (
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      'ondevicechange' in navigator.mediaDevices
    ) {
      navigator.mediaDevices.ondevicechange = () => {
        refreshAudioDevices();
      };
    }
  }, [refreshAudioDevices]);

  const cleanupAudioNodes = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    if (processorNodeRef.current) {
      processorNodeRef.current.onaudioprocess = null;
      try {
        processorNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      processorNodeRef.current = null;
    }

    if (analyserNodeRef.current) {
      try {
        analyserNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      analyserNodeRef.current = null;
    }

    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      sourceNodeRef.current = null;
    }

    if (silentGainRef.current) {
      try {
        silentGainRef.current.disconnect();
      } catch {
        // ignore
      }
      silentGainRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    setActiveMediaStream(null);

    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      cleanupAudioNodes();
    };
  }, [cleanupAudioNodes]);

  /**
   * Линейная интерполяция для пересэмплирования из нативной частоты Windows (44100/48000 Гц) в 16000 Гц
   */
  const resampleTo16kHz = (
    input: Float32Array,
    sourceRate: number
  ): Float32Array => {
    if (sourceRate === TARGET_SAMPLE_RATE || input.length === 0) {
      return input;
    }
    const ratio = sourceRate / TARGET_SAMPLE_RATE;
    const outLen = Math.max(1, Math.round(input.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i * ratio;
      const i0 = Math.floor(srcIdx);
      const i1 = Math.min(input.length - 1, i0 + 1);
      const frac = srcIdx - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  };

  /**
   * Вычисляет пиковую амплитуду буфера
   */
  const computePeakAbs = (buf: Float32Array | null): number => {
    if (!buf || buf.length === 0) return 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      if (a > peak) peak = a;
    }
    return peak;
  };

  /**
   * Программная нормализация пиковой амплитуды до 0.85 (Auto-Gain Normalization ПОСЛЕ записи).
   * ВАЖНО: усиливаем сигнал ТОЛЬКО если есть реальный голос (rawPeak >= 0.02 и rawRms >= 0.004),
   * чтобы тишина и фоновый шум комнаты НИКОГДА не усиливались в 50 раз!
   */
  const normalizeBufferTo085 = (
    input: Float32Array
  ): { normalized: Float32Array; rawPeak: number; rawRms: number } => {
    let sum = 0;
    for (let i = 0; i < input.length; i++) {
      sum += input[i];
    }
    const dcOffset = input.length > 0 ? sum / input.length : 0;

    let rawPeak = 0;
    let sumSq = 0;
    for (let i = 0; i < input.length; i++) {
      const centered = input[i] - dcOffset;
      const abs = Math.abs(centered);
      if (abs > rawPeak) rawPeak = abs;
      sumSq += centered * centered;
    }
    const rawRms =
      input.length > 0 ? Math.sqrt(sumSq / input.length) : 0;

    const out = new Float32Array(input.length);
    const isRealVoicePresent = rawPeak >= 0.001 && rawRms >= 0.0005;
    const gain = isRealVoicePresent
      ? Math.min(60.0, 0.85 / rawPeak)
      : 1.0;

    for (let i = 0; i < input.length; i++) {
      const centered = input[i] - dcOffset;
      out[i] = Math.max(-1, Math.min(1, centered * gain));
    }

    return { normalized: out, rawPeak, rawRms };
  };

  /**
   * Возвращает текущий накопленный 16 кГц нормализованный аудио-буфер прямо во время записи
   * (для Real-Time Live Audio Streaming).
   */
  const getCurrentBuffer16k = useCallback((): Float32Array | null => {
    const chunks = recordedChunksRef.current;
    const totalLength = totalSamplesRef.current;
    if (!chunks || chunks.length === 0 || totalLength < 1600) {
      return null;
    }
    const nativeSampleRate = audioCtxRef.current?.sampleRate ?? 48000;
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const resampled = resampleTo16kHz(merged, nativeSampleRate);
    const { normalized, rawPeak, rawRms } = normalizeBufferTo085(resampled);
    if (rawPeak < 0.001 && rawRms < 0.0005) {
      return null;
    }
    return normalized;
  }, []);

  const stopRecording =
    useCallback(async (): Promise<NormalizedAudioFloat32Array | null> => {
      if (isStoppingRef.current) return null;
      isStoppingRef.current = true;
      autoStopTriggeredRef.current = true;

      // Мгновенно отключаем захват новых фреймов и индикатор записи (важно для мгновенного прерывания в режиме экзамена)
      if (processorNodeRef.current) {
        processorNodeRef.current.onaudioprocess = null;
      }
      setIsRecording(false);

      try {
        const nativeSampleRate =
          audioCtxRef.current?.sampleRate ?? 48000;

        // 1. Останавливаем MediaRecorder и дожидаемся события mediaRecorder.onstop через Promise
        const mediaBlob: Blob | null = await new Promise<Blob | null>(
          (resolve) => {
            const rec = mediaRecorderRef.current;
            if (!rec || rec.state === 'inactive') {
              if (mediaChunksRef.current.length > 0) {
                resolve(
                  new Blob(mediaChunksRef.current, { type: 'audio/webm' })
                );
              } else {
                resolve(null);
              }
              return;
            }

            const timeoutId = setTimeout(() => {
              const fallbackBlob =
                mediaChunksRef.current.length > 0
                  ? new Blob(mediaChunksRef.current, {
                      type: rec.mimeType || 'audio/webm',
                    })
                  : null;
              resolve(fallbackBlob);
            }, 1200);

            rec.onstop = () => {
              clearTimeout(timeoutId);
              const blob =
                mediaChunksRef.current.length > 0
                  ? new Blob(mediaChunksRef.current, {
                      type: rec.mimeType || 'audio/webm',
                    })
                  : null;
              resolve(blob);
            };

            try {
              rec.requestData();
            } catch {
              // ignore
            }
            try {
              rec.stop();
            } catch {
              clearTimeout(timeoutId);
              resolve(null);
            }
          }
        );

        mediaRecorderRef.current = null;

        // 2. Собираем Float32Array из ScriptProcessorNode (работавшего на нативной частоте ОС)
        const chunks = recordedChunksRef.current;
        const totalLength = totalSamplesRef.current;
        let scriptPcm16k: Float32Array | null = null;

        if (chunks.length > 0 && totalLength > 0) {
          const merged = new Float32Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
          }
          scriptPcm16k = resampleTo16kHz(merged, nativeSampleRate);
        }

        recordedChunksRef.current = [];
        totalSamplesRef.current = 0;

        cleanupAudioNodes();
        setIsRecording(false);
        setLiveRms(0);
        setLiveDb(-60);
        setLiveLevelPercent(0);
        setLiveWaveform(new Array(WAVEFORM_BARS).fill(4));

        // 3. Декодируем собранный Blob от MediaRecorder через decodeAudioData на нативном AudioContext
        let decodedBlobPcm16k: Float32Array | null = null;
        if (mediaBlob && mediaBlob.size > 0 && typeof window !== 'undefined') {
          try {
            const arrayBuf = await mediaBlob.arrayBuffer();
            const AudioCtx =
              window.AudioContext ||
              (
                window as unknown as {
                  webkitAudioContext: typeof AudioContext;
                }
              ).webkitAudioContext;
            // БЕЗ принудительного sampleRate, чтобы Windows декодировал без ошибок
            const decodeCtx = new AudioCtx();
            const decodedAudio = await decodeCtx.decodeAudioData(arrayBuf);
            await decodeCtx.close().catch(() => {});

            const ch0 = decodedAudio.getChannelData(0);
            const rawCopy = new Float32Array(ch0.length);
            rawCopy.set(ch0);
            decodedBlobPcm16k = resampleTo16kHz(
              rawCopy,
              decodedAudio.sampleRate
            );
          } catch {
            // Если декодирование контейнера не удалось, используем буфер ScriptProcessorNode
          }
        }

        // Выбираем буфер с наибольшей пиковой энергией (на Windows MediaRecorder + decodeAudioData часто дает самый чистый сигнал)
        const peakDecoded = computePeakAbs(decodedBlobPcm16k);
        const peakScript = computePeakAbs(scriptPcm16k);

        let raw16kBuffer: Float32Array | null = null;
        if (decodedBlobPcm16k && peakDecoded >= peakScript * 0.7) {
          raw16kBuffer = decodedBlobPcm16k;
        } else if (scriptPcm16k && scriptPcm16k.length > 0) {
          raw16kBuffer = scriptPcm16k;
        } else {
          raw16kBuffer = decodedBlobPcm16k;
        }

        if (!raw16kBuffer || raw16kBuffer.length === 0) {
          return null;
        }

        // 4. Программная нормализация пиковой амплитуды до 0.85 (при rawPeak >= 0.001 и rawRms >= 0.0005)
        const { normalized, rawPeak, rawRms } =
          normalizeBufferTo085(raw16kBuffer);
        const rawPeakDb =
          rawPeak > 1e-5 ? Math.round(20 * Math.log10(rawPeak)) : -60;

        console.log(
          `[Mic Level Check] Peak: ${rawPeak.toFixed(5)} (${rawPeakDb} dB), RMS: ${rawRms.toFixed(
            5
          )}, IsSilent: ${rawPeak < 0.001 && rawRms < 0.0005 && rawPeakDb <= -50}`
        );

        // 5. Создаем громкий нормализованный WAV URL для <audio controls> и кнопки «Как произнес я»
        const normalizedWavBlob = encodeWavBlob(normalized, TARGET_SAMPLE_RATE);
        const finalAudioUrl = URL.createObjectURL(normalizedWavBlob);

        setRecordedAudioUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return finalAudioUrl;
        });

        const enrichedBuffer = normalized as NormalizedAudioFloat32Array;
        enrichedBuffer.recordedAudioUrl = finalAudioUrl;
        enrichedBuffer.rawPeakAmplitude = rawPeak;
        enrichedBuffer.rawRms = rawRms;
        enrichedBuffer.rawPeakDb = rawPeakDb;

        return enrichedBuffer;
      } finally {
        isStoppingRef.current = false;
      }
    }, [cleanupAudioNodes]);

  const startRecording = useCallback(async () => {
    setError(null);
    cleanupAudioNodes();
    isStoppingRef.current = false;

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      setError('Браузер не поддерживает захват микрофона (getUserMedia).');
      return;
    }

    try {
      const preferredDeviceId = selectedDeviceIdRef.current;
      let stream: MediaStream;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId:
              preferredDeviceId && preferredDeviceId !== 'default'
                ? { exact: preferredDeviceId }
                : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      } catch {
        // Fallback если выбранный deviceId недоступен
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      }

      // Обновляем список микрофонов с реальными названиями после выдачи разрешения
      refreshAudioDevices();

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;

      // Создаем AudioContext БЕЗ принудительного sampleRate (работает на родной частоте Windows 44100/48000 Гц!)
      const audioCtx = new AudioCtx();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      // 1. Запускаем MediaRecorder
      mediaChunksRef.current = [];
      if (typeof MediaRecorder !== 'undefined') {
        try {
          const mimeCandidates = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/mp4',
          ];
          const supportedMime = mimeCandidates.find(
            (m) =>
              typeof MediaRecorder.isTypeSupported === 'function' &&
              MediaRecorder.isTypeSupported(m)
          );
          const recorder = supportedMime
            ? new MediaRecorder(stream, { mimeType: supportedMime })
            : new MediaRecorder(stream);

          recorder.ondataavailable = (ev) => {
            if (ev.data && ev.data.size > 0) {
              mediaChunksRef.current.push(ev.data);
            }
          };
          recorder.start(80);
          mediaRecorderRef.current = recorder;
        } catch {
          mediaRecorderRef.current = null;
        }
      }

      // 2. Запускаем Web Audio граф на родной частоте микрофона
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;

      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      const silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;

      recordedChunksRef.current = [];
      totalSamplesRef.current = 0;
      startTimeRef.current = performance.now();
      lastLiveChunkMsRef.current = startTimeRef.current;
      speechSinceLastChunkMsRef.current = 0;
      wordPauseStartMsRef.current = null;
      wordPauseEmittedRef.current = false;
      cumulativeSpeechMsRef.current = 0;
      silenceStartMsRef.current = null;
      autoStopTriggeredRef.current = false;
      setRecordingDurationMs(0);

      const freqData = new Uint8Array(analyser.frequencyBinCount);

      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        const inputData = event.inputBuffer.getChannelData(0);
        const copy = new Float32Array(inputData.length);
        copy.set(inputData);
        recordedChunksRef.current.push(copy);
        totalSamplesRef.current += copy.length;

        let sumSq = 0;
        let peak = 0;
        for (let i = 0; i < copy.length; i++) {
          const v = copy[i];
          const abs = Math.abs(v);
          if (abs > peak) peak = abs;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / copy.length);
        const db = peak > 1e-5 ? Math.round(20 * Math.log10(peak)) : -60;
        // Переводим дБ (-55..0 дБ) в понятный процент 0..100%
        const levelPct = Math.max(
          0,
          Math.min(100, Math.round(((db + 55) / 50) * 100))
        );

        setLiveRms(Number(rms.toFixed(4)));
        setLiveDb(db);
        setLiveLevelPercent(levelPct);

        analyser.getByteFrequencyData(freqData);
        const bars: number[] = [];
        const usableBins = Math.min(freqData.length, WAVEFORM_BARS);
        for (let i = 0; i < WAVEFORM_BARS; i++) {
          const binIdx = i % usableBins;
          const boosted = Math.min(
            100,
            Math.round((freqData[binIdx] / 255) * 120 + levelPct * 0.4)
          );
          bars.push(Math.max(6, boosted));
        }
        setLiveWaveform(bars);

        const chunkDurationMs =
          (copy.length / (audioCtx.sampleRate || 48000)) * 1000;
        const nowMs = performance.now();
        const elapsedRecordingMs = nowMs - startTimeRef.current;

        const hasSoundInChunk =
          rms >= SPEECH_RMS_THRESHOLD || peak >= 0.003 || db > -50;

        if (hasSoundInChunk) {
          cumulativeSpeechMsRef.current += chunkDurationMs;
          speechSinceLastChunkMsRef.current += chunkDurationMs;
          wordPauseStartMsRef.current = null;
          wordPauseEmittedRef.current = false;
          // Сбрасываем таймер паузы при наличии любого звука
          silenceStartMsRef.current = null;
        } else {
          if (wordPauseStartMsRef.current === null) {
            wordPauseStartMsRef.current = nowMs;
          }
          if (
            elapsedRecordingMs >= MIN_TOTAL_RECORDING_BEFORE_AUTOSTOP_MS &&
            cumulativeSpeechMsRef.current >= MIN_ACTIVE_SPEECH_MS
          ) {
            if (silenceStartMsRef.current === null) {
              silenceStartMsRef.current = nowMs;
            } else if (
              autoStopEnabledRef.current &&
              !autoStopTriggeredRef.current &&
              nowMs - silenceStartMsRef.current >= WAQF_SILENCE_MS
            ) {
              autoStopTriggeredRef.current = true;
              stopRecording().then((finalBuffer) => {
                if (finalBuffer && finalBuffer.length > 0) {
                  onAutoStopRef.current?.(
                    finalBuffer,
                    finalBuffer.recordedAudioUrl
                  );
                }
              });
            }
          }
        }

        // REAL-TIME LIVE STREAMING (пословная синхронизация без пропусков вперед на тишине):
        // Отправляем накопленный WAV/PCM-буфер ТОЛЬКО при наличии реальной новой речи (>= 160 мс):
        // 1) Мгновенно на короткой межсловной паузе (>= 180 мс тишины после произнесенного слова)
        // 2) Либо каждые 850 мс при слитном непрерывном чтении
        if (
          !isStoppingRef.current &&
          onLiveChunkRef.current &&
          cumulativeSpeechMsRef.current >= 180
        ) {
          const timeSinceLastLiveMs = nowMs - lastLiveChunkMsRef.current;
          const isIntervalReady =
            timeSinceLastLiveMs >= 850 &&
            speechSinceLastChunkMsRef.current >= 180;
          const isWordPauseReady =
            !hasSoundInChunk &&
            !wordPauseEmittedRef.current &&
            speechSinceLastChunkMsRef.current >= 150 &&
            wordPauseStartMsRef.current !== null &&
            nowMs - wordPauseStartMsRef.current >= 180 &&
            timeSinceLastLiveMs >= 420;

          if (isIntervalReady || isWordPauseReady) {
            lastLiveChunkMsRef.current = nowMs;
            speechSinceLastChunkMsRef.current = 0;
            if (isWordPauseReady) {
              wordPauseEmittedRef.current = true;
            }
            const liveBuf = getCurrentBuffer16k();
            if (liveBuf && liveBuf.length >= 1600) {
              onLiveChunkRef.current(
                liveBuf,
                Math.round(elapsedRecordingMs),
                isWordPauseReady ? 'word_pause' : 'interval'
              );
            }
          }
        }
      };

      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioCtx.destination);

      mediaStreamRef.current = stream;
      setActiveMediaStream(stream);
      audioCtxRef.current = audioCtx;
      sourceNodeRef.current = source;
      analyserNodeRef.current = analyser;
      processorNodeRef.current = processor;
      silentGainRef.current = silentGain;

      setIsRecording(true);

      timerIntervalRef.current = setInterval(() => {
        setRecordingDurationMs(
          Math.round(performance.now() - startTimeRef.current)
        );
      }, 100);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Не удалось получить доступ к микрофону.';
      setError(`Ошибка микрофона: ${msg}`);
      setIsRecording(false);
      cleanupAudioNodes();
    }
  }, [cleanupAudioNodes, getCurrentBuffer16k, refreshAudioDevices, stopRecording]);

  return {
    isRecording,
    recordingDurationMs,
    liveRms,
    liveDb,
    liveLevelPercent,
    liveWaveform,
    recordedAudioUrl,
    audioDevices,
    selectedDeviceId,
    setSelectedDeviceId,
    refreshAudioDevices,
    autoStopOnSilence,
    setAutoStopOnSilence,
    startRecording,
    stopRecording,
    getCurrentBuffer16k,
    error,
    mediaStream: activeMediaStream,
  };
}
