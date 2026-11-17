'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { WorkerTranscriptionOutput } from '@/lib/quranAiWorker';
import {
  getOrLoadWhisperPipeline,
  runWhisperOnFloat32,
  LiveArabicSpeechMonitor,
} from '@/lib/realSpeechRecognizer';

export type NeuralEngineStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'analyzing'
  | 'error';

export interface UseQuranNeuralEngineReturn {
  engineStatus: NeuralEngineStatus;
  loadingProgress: number;
  activeModelId: string | null;
  warmupEngine: () => void;
  startLiveMonitor: () => void;
  stopLiveMonitor: () => string;
  getLiveTranscript: () => string;
  transcribeAudioBuffer: (
    buffer: Float32Array,
    liveCapturedArabic?: string
  ) => Promise<WorkerTranscriptionOutput | null>;
}

/**
 * Реальный клиентский менеджер нейросетевого распознавания Корана:
 * сочетает локальный ONNX Whisper (`@huggingface/transformers`) и мгновенный монитор арабских букв.
 */
export function useQuranNeuralEngine(): UseQuranNeuralEngineReturn {
  const [engineStatus, setEngineStatus] =
    useState<NeuralEngineStatus>('idle');
  const [loadingProgress, setLoadingProgress] = useState<number>(0);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);

  const liveMonitorRef = useRef<LiveArabicSpeechMonitor | null>(null);

  const warmupEngine = useCallback(() => {
    if (typeof window === 'undefined') return;
    setEngineStatus((prev) => (prev === 'ready' ? 'ready' : 'loading'));
    getOrLoadWhisperPipeline((pct) => {
      setLoadingProgress(pct);
      if (pct >= 100) {
        setEngineStatus('ready');
        setActiveModelId('Xenova/whisper-tiny');
      }
    })
      .then((pipe) => {
        if (pipe) {
          setEngineStatus('ready');
          setLoadingProgress(100);
          setActiveModelId('Xenova/whisper-tiny');
        } else {
          setEngineStatus('idle');
        }
      })
      .catch(() => {
        setEngineStatus('idle');
      });
  }, []);

  useEffect(() => {
    warmupEngine();
  }, [warmupEngine]);

  const startLiveMonitor = useCallback(() => {
    if (!liveMonitorRef.current) {
      liveMonitorRef.current = new LiveArabicSpeechMonitor();
    }
    liveMonitorRef.current.start();
  }, []);

  const stopLiveMonitor = useCallback((): string => {
    if (!liveMonitorRef.current) return '';
    return liveMonitorRef.current.stop();
  }, []);

  const getLiveTranscript = useCallback((): string => {
    if (!liveMonitorRef.current) return '';
    return liveMonitorRef.current.getLatestTranscript();
  }, []);

  const transcribeAudioBuffer = useCallback(
    async (
      buffer: Float32Array,
      liveCapturedArabic?: string
    ): Promise<WorkerTranscriptionOutput | null> => {
      setEngineStatus('analyzing');

      try {
        const whisperResult = await Promise.race([
          runWhisperOnFloat32(buffer, (pct) => setLoadingProgress(pct)),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
        ]);

        setEngineStatus('ready');

        const recognizedText =
          whisperResult?.text || (liveCapturedArabic ?? '').trim();

        if (!recognizedText) {
          return null;
        }

        return {
          text: recognizedText,
          modelId: whisperResult?.modelId ?? 'hybrid-arabic-asr',
        };
      } catch {
        setEngineStatus('ready');
        if (liveCapturedArabic && liveCapturedArabic.trim().length > 0) {
          return {
            text: liveCapturedArabic.trim(),
            modelId: 'live-arabic-asr',
          };
        }
        return null;
      }
    },
    []
  );

  return {
    engineStatus,
    loadingProgress,
    activeModelId,
    warmupEngine,
    startLiveMonitor,
    stopLiveMonitor,
    getLiveTranscript,
    transcribeAudioBuffer,
  };
}
