import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioRecorder,
  useAudioRecorderState,
  type AudioPlayer,
} from 'expo-audio';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import * as Speech from 'expo-speech';
import {
  BellRing,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  RotateCcw,
  Settings2,
  Trash2,
  Volume2,
} from 'lucide-react-native';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Waveform } from '@/components/Waveform';
import { goldenCall, type CallBeat, type GoldenCallScenario } from '@/lib/golden-call';
import {
  cancelScheduledCallNotification,
  prepareNotifications,
  scheduleScheduledCallNotification,
} from '@/lib/notifications';
import {
  createScheduledCall,
  scheduledCallSchema,
  scheduledCallsStorageKey,
  type ScheduledCall,
  type ScheduledCallDraft,
  type ScheduledCallParseResult,
} from '@/lib/scheduled-call';
import type { TranscriptTurn, WebRealtimeCall } from '@/lib/realtime/web-realtime';
import type { WebVoicePreview } from '@/lib/realtime/web-voice-preview';
import {
  createCallAudioScene,
  type ActiveCallAudioScene,
} from '@/lib/realtime/call-audio-scene';
import {
  goldenCallToRealtimeContext,
  scheduledCallToRealtimeContext,
  type RealtimeCallContext,
} from '@/lib/realtime/call-context';
import {
  defaultRealtimeVoice,
  isRealtimeVoice,
  legacyRealtimeVoiceStorageKey,
  realtimeVoicePreviewLine,
  realtimeVoiceOptions,
  realtimeVoiceStorageKey,
  type RealtimeVoice,
} from '@/lib/realtime/voices';

type AppScreen = 'home' | 'settings' | 'schedule' | 'incoming' | 'call' | 'receipt';
type CallPhase = 'caller' | 'your-turn' | 'thinking' | 'overlap' | 'ending';
type EngineMode = 'scripted' | 'connecting' | 'realtime' | 'error';
type ScheduleComposerStatus =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'parsing'
  | 'scheduling'
  | 'error'
  | 'confirmed';
type VoicePreviewState = {
  voice: RealtimeVoice;
  status: 'loading' | 'playing' | 'error';
} | null;

const callEndTransitionMs = 720;

const colors = {
  paper: '#F5F5F7',
  surface: '#FFFFFF',
  ink: '#1D1D1F',
  muted: '#6E6E73',
  border: '#E5E5EA',
  coral: '#007AFF',
  coralSoft: '#EAF3FF',
  green: '#34C759',
  greenDark: '#248A3D',
  moss: '#090A0C',
  mossLight: '#17191E',
  yellow: '#FFD60A',
};

const displayFont = Platform.select({
  ios: 'System',
  android: 'sans-serif',
  web: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif',
});

const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0');
  const remainder = (seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function describeRealtimeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission|notallowed|not allowed|denied/i.test(message)) {
    return 'Microphone access is blocked. Allow microphone access for this page, then try again.';
  }
  if (/notfound|not found|no device/i.test(message)) {
    return 'No microphone was found. Connect one, then try again.';
  }
  return message || 'The live voice call could not connect.';
}

function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function localLocale() {
  return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
}

function displayAudioScene(scene: ScheduledCallDraft['audioScene']) {
  return {
    'quiet-room': 'Quiet room ambience',
    street: 'Street ambience',
    cafe: 'Café ambience',
    car: 'In-car ambience',
    office: 'Office ambience',
    gym: 'Gym ambience',
  }[scene];
}

function formatScheduledCallTime(draft: ScheduledCallDraft) {
  const date = new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeZone: draft.timeZone,
  });
  const time = new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: draft.timeZone,
  });

  if (draft.trigger.mode === 'exact') {
    const at = new Date(draft.trigger.at);
    return `${date.format(at)} · ${time.format(at)}`;
  }

  const startsAt = new Date(draft.trigger.startsAt);
  const endsAt = new Date(draft.trigger.endsAt);
  return `${date.format(startsAt)} · ${time.format(startsAt)}–${time.format(endsAt)}`;
}

function displayCallLanguage(language: string) {
  if (language.toLowerCase().startsWith('en')) return 'English';
  if (language.toLowerCase().startsWith('zh')) return 'Chinese';
  return language;
}

function callerInitials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'R'
  );
}

function formatCountdown(milliseconds: number) {
  if (milliseconds <= 0) return 'Due now';
  const seconds = Math.ceil(milliseconds / 1_000);
  if (seconds < 60) return `in ${seconds} sec`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `in ${hours} hr ${remainingMinutes} min` : `in ${hours} hr`;
  }
  const days = Math.floor(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

function scheduledCallCountdown(call: ScheduledCall, nowMs: number) {
  if (call.status === 'ringing') return 'Ringing now';
  if (call.trigger.mode === 'window') {
    const startsIn = new Date(call.trigger.startsAt).getTime() - nowMs;
    const endsIn = new Date(call.trigger.endsAt).getTime() - nowMs;
    if (startsIn > 0) return `Window opens ${formatCountdown(startsIn)}`;
    if (endsIn > 0) return 'Any moment now';
  }
  return formatCountdown(new Date(call.scheduledFor).getTime() - nowMs);
}

function readScheduledCalls(value: string | null) {
  if (!value) return [];
  try {
    const parsed = scheduledCallSchema.array().safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function scheduledCallFallbackBeats(call: ScheduledCall): CallBeat[] {
  if (call.kind === 'reminder') {
    const items = call.content.reminderItems;
    const reminder =
      items.length > 0
        ? `don't forget ${items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`}`
        : `don't forget about ${call.title.toLowerCase()}`;
    return [
      {
        id: 'reminder',
        callerLine: `Hey, quick reminder—${reminder}.`,
        privateIntent: 'Deliver the reminder clearly.',
      },
      {
        id: 'close',
        callerLine: "Yep, that's it. Just didn't want it to slip your mind. Have a good one.",
        privateIntent: 'Close naturally after the reminder is acknowledged.',
      },
    ];
  }

  return [
    {
      id: 'opener',
      callerLine: `Hey, you got a second? I wanted to call about ${call.title.toLowerCase()}.`,
      privateIntent: 'Raise the real-life situation immediately.',
    },
    {
      id: 'follow-up',
      callerLine: 'Okay, got it. So what do you think we should do?',
      privateIntent: 'Give the learner a chance to complete the objective.',
    },
    {
      id: 'close',
      callerLine: 'All right, sounds good. Have a good one.',
      privateIntent: 'Close naturally after the practical decision.',
    },
  ];
}

function scheduledCallFallbackReceipt(call: ScheduledCall): GoldenCallScenario['receipt'] {
  return {
    outcome: call.kind === 'reminder' ? 'Reminder acknowledged' : call.title,
    score: 80,
    comprehension:
      call.kind === 'reminder'
        ? 'You acknowledged the reminder and kept the exchange moving.'
        : 'You stayed in the situation and responded to the caller’s practical request.',
    missedCue: 'Your personalized hidden-cue feedback will appear after a live Realtime call.',
    originalPhrase: 'I understand it. I will do that.',
    naturalPhrase: 'Got it—I’ll take care of it.',
    replayLabel: call.title,
  };
}

async function apiError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

function playFromStart(player: AudioPlayer) {
  player.pause();
  player.seekTo(0).then(() => player.play()).catch(() => undefined);
}

function PulseAvatar({ initials }: { initials: string }) {
  const [pulse] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1300,
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1300,
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] });

  return (
    <View style={styles.pulseStage}>
      <Animated.View style={[styles.pulseRing, { opacity, transform: [{ scale }] }]} />
      <View style={styles.avatarLarge}>
        <Text style={styles.avatarLargeText}>{initials}</Text>
      </View>
    </View>
  );
}

function RoundAction({
  label,
  color,
  onPress,
  children,
}: {
  label: string;
  color: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.roundActionGroup}>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [
          styles.roundAction,
          { backgroundColor: color, transform: [{ scale: pressed ? 0.94 : 1 }] },
        ]}>
        {children}
      </Pressable>
      <Text style={styles.roundActionLabel}>{label}</Text>
    </View>
  );
}

export default function BetterCallRyan() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 100);
  const connectedPlayer = useAudioPlayer(require('../../assets/sounds/call-connected.wav'));
  const endedPlayer = useAudioPlayer(require('../../assets/sounds/call-ended.wav'));
  const [screen, setScreen] = useState<AppScreen>('home');
  const [callPhase, setCallPhase] = useState<CallPhase>('caller');
  const [turnIndex, setTurnIndex] = useState(0);
  const [scriptedBeatCount, setScriptedBeatCount] = useState(goldenCall.beats.length);
  const [callSeconds, setCallSeconds] = useState(0);
  const [completedCalls, setCompletedCalls] = useState(0);
  const [engineMode, setEngineMode] = useState<EngineMode>('scripted');
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  const [realtimeMuted, setRealtimeMuted] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState<RealtimeVoice>(defaultRealtimeVoice);
  const [activeCallVoice, setActiveCallVoice] = useState<RealtimeVoice>(defaultRealtimeVoice);
  const [voicePreview, setVoicePreview] = useState<VoicePreviewState>(null);
  const [scheduleText, setScheduleText] = useState('');
  const [scheduleStatus, setScheduleStatus] = useState<ScheduleComposerStatus>('idle');
  const [scheduleResult, setScheduleResult] = useState<ScheduledCallParseResult | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [clarificationContext, setClarificationContext] = useState<string | null>(null);
  const [scheduledCalls, setScheduledCalls] = useState<ScheduledCall[]>([]);
  const [activeScheduledCall, setActiveScheduledCall] = useState<ScheduledCall | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [runtimeCallOwner] = useState(() =>
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `screen-${Math.random().toString(36).slice(2, 12)}`,
  );
  const [receipt, setReceipt] = useState<GoldenCallScenario['receipt']>(goldenCall.receipt);
  const endTransitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnAdvanceLock = useRef(false);
  const callFinishedLock = useRef(false);
  const realtimeCall = useRef<WebRealtimeCall | null>(null);
  const voicePreviewController = useRef<WebVoicePreview | null>(null);
  const voicePreviewRequest = useRef(0);
  const selectedVoiceRef = useRef<RealtimeVoice>(defaultRealtimeVoice);
  const scheduledCallsRef = useRef<ScheduledCall[]>([]);
  const activeScheduledCallRef = useRef<ScheduledCall | null>(null);
  const scriptedBeatsRef = useRef<CallBeat[]>(goldenCall.beats);
  const incomingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presentingScheduledCallRef = useRef<string | null>(null);
  const selectedVoiceOption =
    realtimeVoiceOptions.find((voice) => voice.id === selectedVoice) ?? realtimeVoiceOptions[0];
  const activeCallVoiceOption =
    realtimeVoiceOptions.find((voice) => voice.id === activeCallVoice) ?? realtimeVoiceOptions[0];
  const activeCallContext = activeScheduledCall
    ? scheduledCallToRealtimeContext(activeScheduledCall)
    : goldenCallToRealtimeContext();
  const activeCallerInitials = activeScheduledCall
    ? callerInitials(activeScheduledCall.caller.name)
    : goldenCall.caller.initials;
  const activeScheduledCalls = scheduledCalls
    .filter((call) => call.status === 'scheduled' || call.status === 'ringing')
    .sort(
      (left, right) =>
        new Date(left.scheduledFor).getTime() - new Date(right.scheduledFor).getTime(),
    );
  const nextScheduledCall = activeScheduledCalls[0] ?? null;

  async function persistScheduledCalls(calls: ScheduledCall[]) {
    scheduledCallsRef.current = calls;
    setScheduledCalls(calls);
    await AsyncStorage.setItem(scheduledCallsStorageKey, JSON.stringify(calls));
  }

  async function freshScheduledCalls() {
    try {
      const stored = readScheduledCalls(await AsyncStorage.getItem(scheduledCallsStorageKey));
      return stored.length > 0 || scheduledCallsRef.current.length === 0
        ? stored
        : scheduledCallsRef.current;
    } catch {
      return scheduledCallsRef.current;
    }
  }

  async function updateScheduledCallStatus(
    callId: string,
    status: ScheduledCall['status'],
    options: { ringingOwner?: string } = {},
  ) {
    const calls = await freshScheduledCalls();
    const timestamp = new Date().toISOString();
    let updatedCall: ScheduledCall | null = null;
    const nextCalls = calls.map((call) => {
      if (call.id !== callId) return call;
      updatedCall = {
        ...call,
        status,
        ringingOwner:
          status === 'ringing' ? (options.ringingOwner ?? call.ringingOwner) : null,
        ringingStartedAt:
          status === 'ringing'
            ? options.ringingOwner
              ? timestamp
              : (call.ringingStartedAt ?? timestamp)
            : null,
        updatedAt: timestamp,
      };
      return updatedCall;
    });
    if (!updatedCall) return null;
    await persistScheduledCalls(nextCalls);
    if (activeScheduledCallRef.current?.id === callId) {
      activeScheduledCallRef.current = updatedCall;
      setActiveScheduledCall(updatedCall);
    }
    return updatedCall;
  }

  async function markScheduledCallMissed(callId: string, requiredOwner?: string) {
    const calls = await freshScheduledCalls();
    const call = calls.find((candidate) => candidate.id === callId);
    if (!call || !['scheduled', 'ringing', 'in_call'].includes(call.status)) return;
    if (requiredOwner && call.ringingOwner !== requiredOwner) return;
    await updateScheduledCallStatus(callId, 'missed');
    if (incomingTimeoutRef.current) clearTimeout(incomingTimeoutRef.current);
    incomingTimeoutRef.current = null;
    presentingScheduledCallRef.current = null;
    activeScheduledCallRef.current = null;
    setActiveScheduledCall(null);
    setScreen('home');
  }

  async function presentScheduledCall(callId: string) {
    if (presentingScheduledCallRef.current === callId) return;
    presentingScheduledCallRef.current = callId;

    try {
      const calls = await freshScheduledCalls();
      const call = calls.find((candidate) => candidate.id === callId);
      if (!call || (call.status !== 'scheduled' && call.status !== 'ringing')) return;
      if (new Date(call.scheduledFor).getTime() > Date.now()) return;

      if (
        call.status === 'ringing' &&
        call.ringingOwner &&
        call.ringingOwner !== runtimeCallOwner &&
        call.ringingStartedAt &&
        Date.now() - new Date(call.ringingStartedAt).getTime() < 45_000
      ) {
        return;
      }

      const ringingCall =
        call.status === 'ringing' && call.ringingOwner === runtimeCallOwner
          ? call
          : ((await updateScheduledCallStatus(call.id, 'ringing', {
              ringingOwner: runtimeCallOwner,
            })) ?? call);
      activeScheduledCallRef.current = ringingCall;
      setActiveScheduledCall(ringingCall);
      scriptedBeatsRef.current = scheduledCallFallbackBeats(ringingCall);
      setScriptedBeatCount(scriptedBeatsRef.current.length);
      setActiveCallVoice(ringingCall.voice);
      setReceipt(scheduledCallFallbackReceipt(ringingCall));
      setCallSeconds(0);
      setTurnIndex(0);
      setCallPhase('caller');
      setEngineMode('scripted');
      setRealtimeError(null);
      setRealtimeMuted(false);
      callFinishedLock.current = false;
      setScreen('incoming');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );

      if (incomingTimeoutRef.current) clearTimeout(incomingTimeoutRef.current);
      incomingTimeoutRef.current = setTimeout(() => {
        markScheduledCallMissed(ringingCall.id, runtimeCallOwner).catch(() => undefined);
      }, 35_000);
    } finally {
      presentingScheduledCallRef.current = null;
    }
  }

  async function confirmScheduledCall() {
    if (scheduleResult?.status !== 'ready' || scheduleStatus === 'scheduling') return;
    setScheduleStatus('scheduling');
    setScheduleError(null);

    try {
      const call = createScheduledCall(scheduleResult.draft, selectedVoiceRef.current);
      await persistScheduledCalls([...scheduledCallsRef.current, call]);

      let notificationId: string | null = null;
      try {
        notificationId = await scheduleScheduledCallNotification(call);
      } catch {
        // The call remains saved even if native notification permission is unavailable.
      }

      if (notificationId) {
        const updatedCalls = scheduledCallsRef.current.map((savedCall) =>
          savedCall.id === call.id ? { ...savedCall, notificationId } : savedCall,
        );
        await persistScheduledCalls(updatedCalls);
      }

      setScheduleStatus('confirmed');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
    } catch (error) {
      setScheduleError(
        error instanceof Error ? error.message : 'This call could not be scheduled.',
      );
      setScheduleStatus('error');
    }
  }

  async function cancelScheduledCall(call: ScheduledCall) {
    const timestamp = new Date().toISOString();
    const nextCalls = scheduledCallsRef.current.map((savedCall) =>
      savedCall.id === call.id
        ? {
            ...savedCall,
            status: 'cancelled' as const,
            ringingOwner: null,
            ringingStartedAt: null,
            updatedAt: timestamp,
          }
        : savedCall,
    );
    await persistScheduledCalls(nextCalls);
    await cancelScheduledCallNotification(call.notificationId).catch(() => undefined);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  }

  function resetScheduleComposer() {
    setScheduleText('');
    setScheduleStatus('idle');
    setScheduleResult(null);
    setScheduleError(null);
    setClarificationContext(null);
  }

  function openScheduleComposer() {
    stopVoicePreview();
    resetScheduleComposer();
    setScreen('schedule');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  }

  async function closeScheduleComposer() {
    if (scheduleStatus === 'recording') {
      await recorder.stop().catch(() => undefined);
    }
    if (Platform.OS !== 'web') {
      setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    }
    resetScheduleComposer();
    setScreen('home');
  }

  async function reviewScheduledCall(textOverride?: string) {
    const answer = (textOverride ?? scheduleText).trim();
    if (!answer) {
      setScheduleError('Tell Ryan when to call and what the call is about.');
      setScheduleStatus('error');
      return;
    }
    if (!apiBaseUrl) {
      setScheduleError('The scheduling service is not configured.');
      setScheduleStatus('error');
      return;
    }

    const requestText = clarificationContext
      ? `${clarificationContext}\nClarification answer: ${answer}`
      : answer;
    setScheduleStatus('parsing');
    setScheduleError(null);

    try {
      const response = await fetch(
        `${apiBaseUrl.replace(/\/$/, '')}/v1/scheduled-calls/parse`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: requestText,
            timeZone: localTimeZone(),
            referenceTime: new Date().toISOString(),
            locale: localLocale(),
            defaultCallLanguage: 'en-US',
          }),
        },
      );
      if (!response.ok) {
        throw new Error(await apiError(response, 'Ryan could not understand that request.'));
      }

      const result = (await response.json()) as ScheduledCallParseResult;
      setScheduleResult(result);
      if (result.status === 'needs_clarification') {
        setClarificationContext(requestText);
        setScheduleText('');
      } else {
        setClarificationContext(null);
      }
      setScheduleStatus('idle');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
    } catch (error) {
      setScheduleError(
        error instanceof Error ? error.message : 'Ryan could not understand that request.',
      );
      setScheduleStatus('error');
    }
  }

  async function transcribeScheduleRecording(uri: string) {
    if (!apiBaseUrl) throw new Error('The transcription service is not configured.');
    const recordingResponse = await fetch(uri);
    const audio = await recordingResponse.blob();
    if (Platform.OS === 'web' && uri.startsWith('blob:')) URL.revokeObjectURL(uri);
    const contentType = audio.type || (Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4');
    const response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/v1/transcriptions`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: audio,
    });
    if (!response.ok) {
      throw new Error(await apiError(response, 'Ryan could not hear that recording.'));
    }
    const result = (await response.json()) as { text?: string };
    if (!result.text?.trim()) throw new Error('No speech was detected. Try again.');
    return result.text.trim();
  }

  async function startScheduleRecording() {
    setScheduleError(null);
    setScheduleResult((current) =>
      current?.status === 'needs_clarification' ? current : null,
    );

    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        throw new Error('Microphone access is required to schedule by voice.');
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setScheduleStatus('recording');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    } catch (error) {
      setScheduleError(
        error instanceof Error ? error.message : 'The microphone could not start.',
      );
      setScheduleStatus('error');
    }
  }

  async function stopScheduleRecording() {
    if (scheduleStatus !== 'recording') return;
    setScheduleStatus('transcribing');

    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error('The recording could not be saved.');
      const transcript = await transcribeScheduleRecording(uri);
      setScheduleText(transcript);
      await reviewScheduledCall(transcript);
    } catch (error) {
      setScheduleError(
        error instanceof Error ? error.message : 'Ryan could not hear that recording.',
      );
      setScheduleStatus('error');
    } finally {
      if (Platform.OS !== 'web') {
        setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      }
    }
  }

  function editScheduledCall() {
    if (scheduleResult?.status === 'ready') {
      setScheduleText(
        scheduleResult.draft.sourceText.replace(
          /\nClarification answer:\s*/g,
          ' — ',
        ),
      );
    }
    setScheduleResult(null);
    setScheduleStatus('idle');
    setScheduleError(null);
    setClarificationContext(null);
  }

  function openIncomingCall() {
    stopVoicePreview();
    if (incomingTimeoutRef.current) clearTimeout(incomingTimeoutRef.current);
    incomingTimeoutRef.current = null;
    activeScheduledCallRef.current = null;
    setActiveScheduledCall(null);
    scriptedBeatsRef.current = goldenCall.beats;
    setScriptedBeatCount(goldenCall.beats.length);
    const callVoice = selectedVoiceRef.current;
    setActiveCallVoice(callVoice);
    if (endTransitionTimer.current) clearTimeout(endTransitionTimer.current);
    realtimeCall.current?.close();
    realtimeCall.current = null;
    Speech.stop();
    setCallSeconds(0);
    setTurnIndex(0);
    setCallPhase('caller');
    setEngineMode('scripted');
    setRealtimeError(null);
    setRealtimeMuted(false);
    setReceipt(goldenCall.receipt);
    callFinishedLock.current = false;
    setScreen('incoming');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  }

  function declineIncomingCall() {
    const scheduledCall = activeScheduledCallRef.current;
    if (scheduledCall) {
      markScheduledCallMissed(scheduledCall.id).catch(() => undefined);
      return;
    }
    returnHome();
  }

  function speakBeat(index: number) {
    const beats = scriptedBeatsRef.current;
    if (index >= beats.length) {
      finishCall();
      return;
    }

    setTurnIndex(index);
    setCallPhase('caller');
    Speech.stop();
    Speech.speak(beats[index].callerLine, {
      language: activeScheduledCallRef.current?.callLanguage ?? 'en-US',
      rate: 0.96,
      pitch: 1.02,
      onStart: () => setCallPhase('caller'),
      onDone: () => {
        turnAdvanceLock.current = false;
        setCallPhase('your-turn');
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      },
      onError: () => {
        turnAdvanceLock.current = false;
        setCallPhase('your-turn');
      },
    });
  }

  async function startRealtimeIfAvailable(
    voice: RealtimeVoice,
    callContext: RealtimeCallContext,
    audioScene: ActiveCallAudioScene | null,
  ) {
    if (Platform.OS !== 'web' || !apiBaseUrl) {
      audioScene?.close();
      setRealtimeError('The live voice server is not configured.');
      setEngineMode('error');
      return false;
    }

    try {
      const { startWebRealtimeCall } = await import('@/lib/realtime/web-realtime');
      const controller = await startWebRealtimeCall(
        apiBaseUrl,
        {
          onPhase(phase) {
            setCallPhase(phase);
          },
          onComplete(outcome) {
            finishCall(outcome);
          },
          onError(error) {
            setRealtimeError(describeRealtimeError(error));
          },
        },
        callContext,
        voice,
        audioScene,
      );
      realtimeCall.current = controller;
      setEngineMode('realtime');
      setRealtimeMuted(false);
      return true;
    } catch (error) {
      audioScene?.close();
      realtimeCall.current = null;
      setRealtimeError(describeRealtimeError(error));
      setEngineMode('error');
      return false;
    }
  }

  async function answerCall(startAt = 0) {
    stopVoicePreview();
    if (incomingTimeoutRef.current) clearTimeout(incomingTimeoutRef.current);
    incomingTimeoutRef.current = null;
    const scheduledCall = activeScheduledCallRef.current;
    const callVoice = scheduledCall?.voice ?? selectedVoiceRef.current;
    const callContext = scheduledCall
      ? scheduledCallToRealtimeContext(scheduledCall)
      : goldenCallToRealtimeContext();
    const shouldStartRealtime = startAt === 0 && Platform.OS === 'web';
    const audioScene = shouldStartRealtime
      ? createCallAudioScene(callContext.audioScene)
      : null;
    audioScene?.start().catch(() => undefined);
    if (!scheduledCall) setSelectedVoice(callVoice);
    setActiveCallVoice(callVoice);
    if (endTransitionTimer.current) clearTimeout(endTransitionTimer.current);
    realtimeCall.current?.close();
    realtimeCall.current = null;
    callFinishedLock.current = false;
    turnAdvanceLock.current = false;
    scriptedBeatsRef.current = scheduledCall
      ? scheduledCallFallbackBeats(scheduledCall)
      : goldenCall.beats;
    setScriptedBeatCount(scriptedBeatsRef.current.length);
    setReceipt(
      scheduledCall ? scheduledCallFallbackReceipt(scheduledCall) : goldenCall.receipt,
    );
    if (scheduledCall) {
      await updateScheduledCallStatus(scheduledCall.id, 'in_call');
    }
    setEngineMode(shouldStartRealtime ? 'connecting' : 'scripted');
    setRealtimeError(null);
    setRealtimeMuted(false);
    setScreen('call');
    setCallSeconds(0);
    setCallPhase('caller');
    setTurnIndex(startAt);
    playFromStart(connectedPlayer);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);

    if (shouldStartRealtime) {
      await startRealtimeIfAvailable(callVoice, callContext, audioScene);
      return;
    }

    setTimeout(() => speakBeat(startAt), 550);

    if (Platform.OS !== 'web') {
      try {
        const permission = await AudioModule.requestRecordingPermissionsAsync();
        if (permission.granted) {
          await setAudioModeAsync({
            allowsRecording: true,
            playsInSilentMode: true,
          });
        }
      } catch {
        // The scripted demo still runs if audio permissions are unavailable.
      }
    }
  }

  async function beginUserTurn() {
    if (realtimeCall.current) return;

    if (callPhase !== 'your-turn' || recorderState.isRecording) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);

    if (Platform.OS === 'web') return;

    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch {
      // Keep the scripted progression usable in browsers without microphone access.
    }
  }

  async function finishUserTurn() {
    if (realtimeCall.current) return;

    if (callPhase !== 'your-turn' || turnAdvanceLock.current) return;
    turnAdvanceLock.current = true;
    setCallPhase('thinking');

    try {
      if (recorderState.isRecording) await recorder.stop();
    } catch {
      // Advancing the conversation is more useful than trapping the learner on an audio error.
    }

    if (turnIndex === scriptedBeatsRef.current.length - 1) {
      setTimeout(() => finishCall(), 420);
    } else {
      setTimeout(() => speakBeat(turnIndex + 1), 750);
    }
  }

  function toggleRealtimeMute() {
    const controller = realtimeCall.current;
    if (!controller) return;
    const nextMuted = !realtimeMuted;
    controller.setMuted(nextMuted);
    setRealtimeMuted(nextMuted);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  }

  function stopVoicePreview() {
    voicePreviewRequest.current += 1;
    voicePreviewController.current?.close();
    voicePreviewController.current = null;
    setVoicePreview(null);
  }

  async function chooseVoice(voice: RealtimeVoice) {
    selectedVoiceRef.current = voice;
    setSelectedVoice(voice);
    await AsyncStorage.setItem(realtimeVoiceStorageKey, voice).catch(() => undefined);
    Haptics.selectionAsync().catch(() => undefined);

    voicePreviewRequest.current += 1;
    const requestId = voicePreviewRequest.current;
    voicePreviewController.current?.close();
    voicePreviewController.current = null;
    setVoicePreview({ voice, status: 'loading' });

    if (Platform.OS !== 'web' || !apiBaseUrl) {
      setVoicePreview({ voice, status: 'error' });
      return;
    }

    try {
      const { startWebRealtimeVoicePreview } = await import(
        '@/lib/realtime/web-voice-preview'
      );
      const controller = await startWebRealtimeVoicePreview(
        apiBaseUrl,
        voice,
        realtimeVoicePreviewLine,
        {
          onPlaying() {
            if (voicePreviewRequest.current === requestId) {
              setVoicePreview({ voice, status: 'playing' });
            }
          },
          onEnded() {
            if (voicePreviewRequest.current === requestId) {
              voicePreviewController.current = null;
              setVoicePreview(null);
            }
          },
          onError() {
            if (voicePreviewRequest.current === requestId) {
              voicePreviewController.current = null;
              setVoicePreview({ voice, status: 'error' });
            }
          },
        },
      );
      if (voicePreviewRequest.current !== requestId) {
        controller.close();
        return;
      }
      voicePreviewController.current = controller;
    } catch {
      if (voicePreviewRequest.current === requestId) {
        setVoicePreview({ voice, status: 'error' });
      }
    }
  }

  async function generateReceipt(turns: TranscriptTurn[], call: RealtimeCallContext) {
    if (!apiBaseUrl || turns.length === 0) return;

    try {
      const response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/v1/receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ call, turns }),
      });
      if (!response.ok) return;
      const generated = (await response.json()) as GoldenCallScenario['receipt'];
      setReceipt(generated);
    } catch {
      // Keep the deterministic receipt when the coach endpoint is offline.
    }
  }

  function finishCall(outcome?: string) {
    if (callFinishedLock.current) return;
    callFinishedLock.current = true;

    const controller = realtimeCall.current;
    const transcript = controller?.getTranscript() ?? [];
    const scheduledCall = activeScheduledCallRef.current;
    const callContext = scheduledCall
      ? scheduledCallToRealtimeContext(scheduledCall)
      : goldenCallToRealtimeContext();
    controller?.close();
    realtimeCall.current = null;
    setRealtimeMuted(false);
    Speech.stop();
    if (outcome) setReceipt((current) => ({ ...current, outcome }));
    if (transcript.length > 0) generateReceipt(transcript, callContext);
    if (scheduledCall) {
      const completedCall = {
        ...scheduledCall,
        status: 'completed' as const,
        updatedAt: new Date().toISOString(),
      };
      activeScheduledCallRef.current = completedCall;
      setActiveScheduledCall(completedCall);
      updateScheduledCallStatus(scheduledCall.id, 'completed').catch(() => undefined);
    }
    setCallPhase('ending');
    playFromStart(endedPlayer);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    setCompletedCalls((value) => {
      const next = value + 1;
      AsyncStorage.setItem('completedCalls', String(next)).catch(() => undefined);
      return next;
    });
    endTransitionTimer.current = setTimeout(() => {
      setScreen('receipt');
      setCallPhase('caller');
      endTransitionTimer.current = null;
    }, callEndTransitionMs);
  }

  function returnHome() {
    stopVoicePreview();
    if (incomingTimeoutRef.current) clearTimeout(incomingTimeoutRef.current);
    incomingTimeoutRef.current = null;
    if (endTransitionTimer.current) clearTimeout(endTransitionTimer.current);
    endTransitionTimer.current = null;
    realtimeCall.current?.close();
    realtimeCall.current = null;
    Speech.stop();
    setScreen('home');
    setEngineMode('scripted');
    setRealtimeError(null);
    setRealtimeMuted(false);
    const scheduledCall = activeScheduledCallRef.current;
    if (scheduledCall && (scheduledCall.status === 'ringing' || scheduledCall.status === 'in_call')) {
      updateScheduledCallStatus(scheduledCall.id, 'missed').catch(() => undefined);
    }
    activeScheduledCallRef.current = null;
    setActiveScheduledCall(null);
    scriptedBeatsRef.current = goldenCall.beats;
    setScriptedBeatCount(goldenCall.beats.length);
  }

  const handleGoldenNotification = useEffectEvent((declined: boolean) => {
    if (declined) returnHome();
    else openIncomingCall();
  });

  const handleScheduledNotification = useEffectEvent(
    (callId: string, declined: boolean) => {
      if (declined) markScheduledCallMissed(callId).catch(() => undefined);
      else presentScheduledCall(callId).catch(() => undefined);
    },
  );

  const handleDueScheduledCall = useEffectEvent((callId: string) => {
    presentScheduledCall(callId).catch(() => undefined);
  });

  useEffect(() => {
    AsyncStorage.getItem('completedCalls').then((value) => {
      if (value) setCompletedCalls(Number(value));
    });
    const syncSelectedVoice = async () => {
      try {
        let value = await AsyncStorage.getItem(realtimeVoiceStorageKey);
        if (!isRealtimeVoice(value)) {
          value = await AsyncStorage.getItem(legacyRealtimeVoiceStorageKey);
          if (isRealtimeVoice(value)) {
            await AsyncStorage.setItem(realtimeVoiceStorageKey, value);
          }
        }
        if (!isRealtimeVoice(value)) return;
        selectedVoiceRef.current = value;
        setSelectedVoice(value);
      } catch {
        // Keep the current in-memory selection when persistence is unavailable.
      }
    };
    const syncScheduledCalls = async () => {
      try {
        const value = await AsyncStorage.getItem(scheduledCallsStorageKey);
        const calls = readScheduledCalls(value);
        scheduledCallsRef.current = calls;
        setScheduledCalls(calls);
      } catch {
        // Keep the current list if storage is temporarily unavailable.
      }
    };
    syncSelectedVoice().catch(() => undefined);
    syncScheduledCalls().catch(() => undefined);

    const handleVoiceStorageChange =
      Platform.OS === 'web'
        ? (event: StorageEvent) => {
            if (event.key !== realtimeVoiceStorageKey) return;
            const voice = isRealtimeVoice(event.newValue)
              ? event.newValue
              : defaultRealtimeVoice;
            selectedVoiceRef.current = voice;
            setSelectedVoice(voice);
          }
        : null;
    const handleScheduledCallsStorageChange =
      Platform.OS === 'web'
        ? (event: StorageEvent) => {
            if (event.key !== scheduledCallsStorageKey) return;
            const calls = readScheduledCalls(event.newValue);
            scheduledCallsRef.current = calls;
            setScheduledCalls(calls);
          }
        : null;
    const handleWindowFocus =
      Platform.OS === 'web'
        ? () => {
            syncSelectedVoice().catch(() => undefined);
            syncScheduledCalls().catch(() => undefined);
          }
        : null;
    const handleVisibilityChange =
      Platform.OS === 'web'
        ? () => {
            if (document.visibilityState === 'visible') {
              syncSelectedVoice().catch(() => undefined);
              syncScheduledCalls().catch(() => undefined);
            }
          }
        : null;

    if (Platform.OS === 'web') {
      window.addEventListener('storage', handleVoiceStorageChange!);
      window.addEventListener('storage', handleScheduledCallsStorageChange!);
      window.addEventListener('focus', handleWindowFocus!);
      document.addEventListener('visibilitychange', handleVisibilityChange!);
    }

    const received =
      Platform.OS === 'web'
        ? null
        : Notifications.addNotificationReceivedListener((notification) => {
            const data = notification.request.content.data;
            if (data?.type === 'golden-call') {
              handleGoldenNotification(false);
            } else if (data?.type === 'scheduled-call' && typeof data.callId === 'string') {
              handleScheduledNotification(data.callId, false);
            }
          });

    const responded =
      Platform.OS === 'web'
        ? null
        : Notifications.addNotificationResponseReceivedListener((response) => {
            const data = response.notification.request.content.data;
            const declined = response.actionIdentifier === 'decline';
            if (data?.type === 'golden-call') {
              handleGoldenNotification(declined);
            } else if (data?.type === 'scheduled-call' && typeof data.callId === 'string') {
              handleScheduledNotification(data.callId, declined);
            }
          });

    if (Platform.OS !== 'web') {
      prepareNotifications()
        .then(() => undefined)
        .catch(() => undefined);
    }

    return () => {
      received?.remove();
      responded?.remove();
      if (Platform.OS === 'web') {
        window.removeEventListener('storage', handleVoiceStorageChange!);
        window.removeEventListener('storage', handleScheduledCallsStorageChange!);
        window.removeEventListener('focus', handleWindowFocus!);
        document.removeEventListener('visibilitychange', handleVisibilityChange!);
      }
      if (endTransitionTimer.current) clearTimeout(endTransitionTimer.current);
      if (incomingTimeoutRef.current) clearTimeout(incomingTimeoutRef.current);
      realtimeCall.current?.close();
      voicePreviewRequest.current += 1;
      voicePreviewController.current?.close();
      connectedPlayer.pause();
      endedPlayer.pause();
      Speech.stop();
    };
  }, [connectedPlayer, endedPlayer]);

  useEffect(() => {
    if (screen !== 'call') return;
    const interval = setInterval(() => setCallSeconds((value) => value + 1), 1_000);
    return () => clearInterval(interval);
  }, [screen]);

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (screen !== 'home' || activeScheduledCallRef.current) return;
    if (
      Platform.OS === 'web' &&
      (document.visibilityState !== 'visible' || !document.hasFocus())
    ) {
      return;
    }

    const dueCall = scheduledCalls.find(
      (call) =>
        (call.status === 'scheduled' || call.status === 'ringing') &&
        new Date(call.scheduledFor).getTime() <= nowMs,
    );
    if (dueCall) handleDueScheduledCall(dueCall.id);
  }, [nowMs, scheduledCalls, screen]);

  if (screen === 'settings') {
    return (
      <SafeAreaView style={[styles.fullScreen, styles.paperBackground]}>
        <ScrollView contentContainerStyle={[styles.phoneFrame, styles.settingsContent]}>
          <View style={styles.settingsNav}>
            <Pressable
              accessibilityLabel="Back to home"
              accessibilityRole="button"
              onPress={() => {
                stopVoicePreview();
                setScreen('home');
              }}
              style={({ pressed }) => [styles.backButton, pressed && styles.buttonPressed]}>
              <ChevronLeft color={colors.ink} size={23} strokeWidth={2.2} />
            </Pressable>
            <Text style={styles.settingsNavTitle}>Settings</Text>
            <View style={styles.settingsNavSpacer} />
          </View>

          <View style={styles.settingsHero}>
            <Text style={styles.eyebrow}>CALLER VOICE</Text>
            <Text style={styles.settingsTitle}>Choose how Alex sounds.</Text>
            <Text style={styles.settingsSubtitle}>
              Tap any voice to hear the same phone line. Keep the one that feels least like an
              assistant.
            </Text>
          </View>

          <View style={styles.voicePreviewCard}>
            <View style={styles.voicePreviewIcon}>
              <Volume2 color={colors.coral} size={19} strokeWidth={2.2} />
            </View>
            <View style={styles.voicePreviewCopy}>
              <Text style={styles.voicePreviewLabel}>VOICE PREVIEW</Text>
              <Text style={styles.voicePreviewLine}>“{realtimeVoicePreviewLine}”</Text>
            </View>
          </View>

          <View style={styles.voiceGroup}>
            {realtimeVoiceOptions.map((voice, index) => {
              const selected = voice.id === selectedVoice;
              const previewStatus =
                voicePreview?.voice === voice.id ? voicePreview.status : undefined;
              return (
                <View key={voice.id}>
                  <Pressable
                    accessibilityLabel={`Select and preview ${voice.label} voice`}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => chooseVoice(voice.id)}
                    style={({ pressed }) => [
                      styles.voiceRow,
                      selected && styles.voiceRowSelected,
                      pressed && styles.voiceRowPressed,
                    ]}>
                    <View style={[styles.voiceIcon, selected && styles.voiceIconSelected]}>
                      <Volume2
                        color={selected ? colors.coral : colors.muted}
                        size={20}
                        strokeWidth={2.1}
                      />
                    </View>
                    <View style={styles.voiceCopy}>
                      <Text style={styles.voiceName}>{voice.label}</Text>
                      <Text style={styles.voiceNote}>
                        {previewStatus === 'loading'
                          ? 'Connecting preview…'
                          : previewStatus === 'playing'
                            ? 'Playing the sample line…'
                            : previewStatus === 'error'
                              ? 'Preview unavailable — tap to retry'
                              : voice.recommended
                          ? 'Recommended by OpenAI for best quality'
                          : 'Built-in Realtime voice'}
                      </Text>
                    </View>
                    {previewStatus === 'loading' ? (
                      <ActivityIndicator color={colors.coral} size="small" />
                    ) : previewStatus === 'playing' ? (
                      <View style={[styles.voiceCheck, styles.voicePlaying]}>
                        <Volume2 color="white" size={13} strokeWidth={2.6} />
                      </View>
                    ) : selected ? (
                      <View style={styles.voiceCheck}>
                        <Check color="white" size={14} strokeWidth={3} />
                      </View>
                    ) : null}
                  </Pressable>
                  {index < realtimeVoiceOptions.length - 1 ? (
                    <View style={styles.voiceDivider} />
                  ) : null}
                </View>
              );
            })}
          </View>

          <Text style={styles.settingsFootnote}>
            The preview and your next live call use the same Realtime voice. Once a call starts,
            its voice stays fixed until it ends.
          </Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === 'schedule') {
    const readyDraft = scheduleResult?.status === 'ready' ? scheduleResult.draft : null;
    const clarification =
      scheduleResult?.status === 'needs_clarification' ? scheduleResult : null;
    const isRecordingSchedule = scheduleStatus === 'recording';
    const isTranscribing = scheduleStatus === 'transcribing';
    const isParsingSchedule = scheduleStatus === 'parsing';
    const isScheduling = scheduleStatus === 'scheduling';
    const isScheduleBusy = isTranscribing || isParsingSchedule || isScheduling;

    return (
      <SafeAreaView style={[styles.fullScreen, styles.paperBackground]}>
        <ScrollView
          contentContainerStyle={[styles.phoneFrame, styles.scheduleContent]}
          keyboardShouldPersistTaps="handled">
          <View style={styles.settingsNav}>
            <Pressable
              accessibilityLabel="Back to home"
              accessibilityRole="button"
              onPress={() => closeScheduleComposer().catch(() => undefined)}
              style={({ pressed }) => [styles.backButton, pressed && styles.buttonPressed]}>
              <ChevronLeft color={colors.ink} size={23} strokeWidth={2.2} />
            </Pressable>
            <Text style={styles.settingsNavTitle}>Schedule a call</Text>
            <View style={styles.settingsNavSpacer} />
          </View>

          <View style={styles.scheduleHero}>
            <Text style={styles.eyebrow}>CALL COMPOSER</Text>
            <Text style={styles.scheduleTitle}>
              {readyDraft ? 'Does this look right?' : 'What should Ryan call about?'}
            </Text>
            <Text style={styles.scheduleSubtitle}>
              {readyDraft
                ? 'Check the time and details before anything is scheduled.'
                : 'Say it naturally. Ryan will understand the time and purpose.'}
            </Text>
          </View>

          {readyDraft ? (
            <>
              <View style={styles.confirmationCard}>
                <View style={styles.confirmationTopRow}>
                  <View
                    style={[
                      styles.callKindBadge,
                      readyDraft.kind === 'reminder' && styles.reminderKindBadge,
                    ]}>
                    <Text
                      style={[
                        styles.callKindBadgeText,
                        readyDraft.kind === 'reminder' && styles.reminderKindBadgeText,
                      ]}>
                      {readyDraft.kind === 'reminder' ? 'REMINDER CALL' : 'PRACTICE CALL'}
                    </Text>
                  </View>
                  {scheduleStatus === 'confirmed' ? (
                    <View style={styles.confirmedMark}>
                      <Check color={colors.greenDark} size={14} strokeWidth={3} />
                      <Text style={styles.confirmedMarkText}>CONFIRMED</Text>
                    </View>
                  ) : null}
                </View>

                <Text style={styles.confirmationTitle}>{readyDraft.title}</Text>

                <View style={styles.confirmationDetailRow}>
                  <View style={styles.confirmationIcon}>
                    <Clock3 color={colors.coral} size={17} strokeWidth={2.3} />
                  </View>
                  <View style={styles.confirmationDetailCopy}>
                    <Text style={styles.confirmationDetailLabel}>WHEN</Text>
                    <Text style={styles.confirmationDetailValue}>
                      {formatScheduledCallTime(readyDraft)}
                    </Text>
                  </View>
                </View>

                <View style={styles.confirmationDivider} />

                <View style={styles.confirmationDetailRow}>
                  <View style={styles.confirmationIcon}>
                    <Phone color={colors.coral} size={17} strokeWidth={2.3} />
                  </View>
                  <View style={styles.confirmationDetailCopy}>
                    <Text style={styles.confirmationDetailLabel}>CALLER</Text>
                    <Text style={styles.confirmationDetailValue}>
                      {readyDraft.caller.name} · {readyDraft.caller.relationship} ·{' '}
                      {displayCallLanguage(readyDraft.callLanguage)}
                    </Text>
                  </View>
                </View>

                <View style={styles.confirmationDivider} />

                <View style={styles.confirmationDetailRow}>
                  <View style={styles.confirmationIcon}>
                    <Volume2 color={colors.coral} size={17} strokeWidth={2.3} />
                  </View>
                  <View style={styles.confirmationDetailCopy}>
                    <Text style={styles.confirmationDetailLabel}>CALL FEEL</Text>
                    <Text style={styles.confirmationDetailValue}>
                      {readyDraft.caller.personality} · {displayAudioScene(readyDraft.audioScene)}
                    </Text>
                  </View>
                </View>

                <View style={styles.confirmationSummary}>
                  <Text style={styles.confirmationSummaryText}>
                    {readyDraft.content.summary}
                  </Text>
                  {readyDraft.content.reminderItems.length > 0 ? (
                    <View style={styles.reminderItems}>
                      {readyDraft.content.reminderItems.map((item) => (
                        <View key={item} style={styles.reminderItemRow}>
                          <View style={styles.reminderItemDot} />
                          <Text style={styles.reminderItemText}>{item}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>
              </View>

              {scheduleStatus === 'confirmed' ? (
                <View style={styles.detailsConfirmedCard}>
                  <View style={styles.detailsConfirmedIcon}>
                    <Check color="white" size={18} strokeWidth={3} />
                  </View>
                  <View style={styles.detailsConfirmedCopy}>
                    <Text style={styles.detailsConfirmedTitle}>Call scheduled</Text>
                    <Text style={styles.detailsConfirmedText}>
                      It is saved on this device and will stay here after you close the app.
                    </Text>
                  </View>
                </View>
              ) : null}

              {scheduleError ? (
                <View style={styles.scheduleErrorCard}>
                  <Text style={styles.scheduleErrorText}>{scheduleError}</Text>
                </View>
              ) : null}

              <Pressable
                accessibilityRole="button"
                disabled={isScheduling}
                onPress={() => {
                  if (scheduleStatus === 'confirmed') {
                    closeScheduleComposer().catch(() => undefined);
                  } else {
                    confirmScheduledCall().catch(() => undefined);
                  }
                }}
                style={({ pressed }) => [
                  styles.primaryButton,
                  styles.confirmPrimaryButton,
                  pressed && styles.buttonPressed,
                  isScheduling && styles.scheduleReviewButtonDisabled,
                ]}>
                {isScheduling ? (
                  <ActivityIndicator color="white" size="small" />
                ) : (
                  <Check color="white" size={19} strokeWidth={2.7} />
                )}
                <Text style={styles.primaryButtonText}>
                  {scheduleStatus === 'confirmed'
                    ? 'Done'
                    : isScheduling
                      ? 'Scheduling…'
                      : 'Schedule call'}
                </Text>
              </Pressable>
              {scheduleStatus !== 'confirmed' ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={isScheduling}
                  onPress={editScheduledCall}
                  style={({ pressed }) => [
                    styles.scheduleEditButton,
                    pressed && styles.buttonPressed,
                  ]}>
                  <Text style={styles.scheduleEditButtonText}>Edit request</Text>
                </Pressable>
              ) : null}
            </>
          ) : (
            <>
              {clarification ? (
                <View style={styles.clarificationCard}>
                  <Text style={styles.clarificationEyebrow}>ONE MORE DETAIL</Text>
                  <Text style={styles.clarificationQuestion}>{clarification.question}</Text>
                </View>
              ) : null}

              <Pressable
                accessibilityLabel={
                  isRecordingSchedule ? 'Stop recording' : 'Start voice scheduling'
                }
                accessibilityRole="button"
                disabled={isScheduleBusy}
                onPress={() =>
                  isRecordingSchedule
                    ? stopScheduleRecording().catch(() => undefined)
                    : startScheduleRecording().catch(() => undefined)
                }
                style={({ pressed }) => [
                  styles.scheduleVoiceCard,
                  isRecordingSchedule && styles.scheduleVoiceCardRecording,
                  pressed && !isScheduleBusy && styles.buttonPressed,
                  isScheduleBusy && styles.scheduleVoiceCardBusy,
                ]}>
                <View
                  style={[
                    styles.scheduleMicButton,
                    isRecordingSchedule && styles.scheduleMicButtonRecording,
                  ]}>
                  {isRecordingSchedule ? (
                    <View style={styles.recordStopGlyph} />
                  ) : isScheduleBusy ? (
                    <ActivityIndicator color="white" size="small" />
                  ) : (
                    <Mic color="white" size={25} strokeWidth={2.2} />
                  )}
                </View>
                <View style={styles.scheduleVoiceCopy}>
                  <Text style={styles.scheduleVoiceTitle}>
                    {isRecordingSchedule
                      ? 'Listening…'
                      : isTranscribing
                        ? 'Turning your voice into text…'
                        : isParsingSchedule
                          ? 'Building your call…'
                          : clarification
                            ? 'Answer by voice'
                            : 'Tell Ryan when to call'}
                  </Text>
                  <Text style={styles.scheduleVoiceSubtitle}>
                    {isRecordingSchedule
                      ? 'Tap once when you are finished'
                      : isScheduleBusy
                        ? 'This usually takes a moment'
                        : 'Tap once to start — no holding required'}
                  </Text>
                </View>
                {isRecordingSchedule ? (
                  <View style={styles.scheduleMiniWaveform}>
                    <Waveform active color={colors.coral} />
                  </View>
                ) : null}
              </Pressable>

              <View style={styles.scheduleOrRow}>
                <View style={styles.scheduleOrRule} />
                <Text style={styles.scheduleOrText}>OR TYPE IT</Text>
                <View style={styles.scheduleOrRule} />
              </View>

              <View style={styles.scheduleTextCard}>
                <TextInput
                  accessibilityLabel="Scheduled call request"
                  editable={!isScheduleBusy && !isRecordingSchedule}
                  multiline
                  onChangeText={(value) => {
                    setScheduleText(value);
                    if (scheduleStatus === 'error') setScheduleStatus('idle');
                    setScheduleError(null);
                  }}
                  placeholder={
                    clarification
                      ? 'Type your answer…'
                      : 'In one hour, remind me to buy carrots, broccoli, and beef.'
                  }
                  placeholderTextColor="#A1A1A6"
                  style={styles.scheduleTextInput}
                  value={scheduleText}
                />
                <Text style={styles.scheduleTextHint}>
                  Speak or type in English or Chinese. Calls default to English.
                </Text>
              </View>

              {scheduleError ? (
                <View style={styles.scheduleErrorCard}>
                  <Text style={styles.scheduleErrorText}>{scheduleError}</Text>
                </View>
              ) : null}

              <Pressable
                accessibilityRole="button"
                disabled={
                  !scheduleText.trim() || isScheduleBusy || isRecordingSchedule
                }
                onPress={() => reviewScheduledCall().catch(() => undefined)}
                style={({ pressed }) => [
                  styles.primaryButton,
                  styles.scheduleReviewButton,
                  (!scheduleText.trim() || isScheduleBusy || isRecordingSchedule) &&
                    styles.scheduleReviewButtonDisabled,
                  pressed && styles.buttonPressed,
                ]}>
                {isParsingSchedule ? (
                  <ActivityIndicator color="white" size="small" />
                ) : null}
                <Text style={styles.primaryButtonText}>
                  {clarification ? 'Update call' : 'Review call'}
                </Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === 'incoming') {
    return (
      <LinearGradient colors={['#1B2028', '#0D0F13', '#050506']} style={styles.fullScreen}>
        <View style={[styles.ambientOrb, styles.ambientOrbBlue]} />
        <View style={[styles.ambientOrb, styles.ambientOrbGreen]} />
        <SafeAreaView style={styles.phoneFrame}>
          <View style={styles.incomingTop}>
            <Text style={styles.incomingTime}>
              {new Intl.DateTimeFormat('en', {
                hour: 'numeric',
                minute: '2-digit',
              }).format(new Date())}
            </Text>
            <View style={styles.practiceBadge}>
              <View style={styles.practiceDot} />
              <Text style={styles.practiceBadgeText}>BETTER CALL RYAN</Text>
            </View>
          </View>

          <View style={styles.incomingIdentity}>
            <PulseAvatar initials={activeCallerInitials} />
            <Text style={styles.incomingName}>{activeCallContext.caller.name}</Text>
            <Text style={styles.incomingRelationship}>
              {activeCallContext.caller.relationship} · {activeCallVoiceOption.label}
            </Text>
            <Text style={styles.incomingContext}>
              {activeCallContext.kind === 'reminder' ? 'Reminder call' : 'Practice call'} ·{' '}
              {activeCallContext.title}
            </Text>
          </View>

          <View style={styles.incomingActions}>
            <RoundAction label="Decline" color="#E44B4B" onPress={declineIncomingCall}>
              <PhoneOff color="white" size={28} strokeWidth={2.3} />
            </RoundAction>
            <RoundAction label="Answer" color={colors.green} onPress={() => answerCall()}>
              <Phone color="white" size={30} strokeWidth={2.3} />
            </RoundAction>
          </View>
        </SafeAreaView>
      </LinearGradient>
    );
  }

  if (screen === 'call') {
    const callerName = activeCallContext.caller.name;
    const isRealtime = engineMode === 'realtime';
    const isConnecting = engineMode === 'connecting';
    const isRealtimeError = engineMode === 'error';
    const isCallUnavailable = isConnecting || isRealtimeError;
    const isEnding = callPhase === 'ending';
    const isListening = isEnding
      ? false
      : isRealtime
      ? (callPhase === 'your-turn' || callPhase === 'overlap') && !realtimeMuted
      : recorderState.isRecording;
    const canTalk = callPhase === 'your-turn';
    const phaseLabel = isEnding
      ? 'Call ended'
      : isConnecting
        ? `Connecting ${activeCallVoiceOption.label}…`
      : isRealtimeError
        ? 'Call couldn’t connect'
      : isRealtime
      ? realtimeMuted
        ? 'Microphone muted'
        : callPhase === 'caller'
          ? `${callerName} is speaking…`
          : callPhase === 'overlap'
            ? `You and ${callerName} are both speaking…`
          : callPhase === 'thinking'
            ? `${callerName} is responding…`
            : 'Listening…'
      : callPhase === 'caller'
        ? `${callerName} is speaking…`
        : callPhase === 'thinking'
          ? `${callerName} is thinking…`
          : turnIndex === scriptedBeatCount - 1
            ? 'Say goodbye to end the call'
          : recorderState.isRecording
            ? 'Listening… let go when finished'
            : 'Your turn — hold to talk';

    return (
      <LinearGradient colors={['#171A20', '#0B0C0F', '#050506']} style={styles.fullScreen}>
        <SafeAreaView style={styles.phoneFrame}>
          <View style={styles.callHeader}>
            <View style={styles.liveStatus}>
              <View style={[styles.liveDot, isEnding && styles.liveDotEnded]} />
              <Text style={styles.liveStatusText}>
                {isEnding
                  ? 'CALL ENDED'
                  : isConnecting
                  ? 'CONNECTING'
                  : isRealtimeError
                  ? 'CALL UNAVAILABLE'
                  : isRealtime
                  ? realtimeMuted
                    ? 'MIC MUTED'
                    : 'LIVE · OPEN MIC'
                  : activeCallContext.kind === 'reminder'
                    ? 'REMINDER CALL'
                    : 'PRACTICE CALL'}
              </Text>
            </View>
            <Text style={styles.callTimer}>{formatDuration(callSeconds)}</Text>
          </View>

          <View style={styles.callCenter}>
            <View style={styles.callAvatar}>
              <Text style={styles.callAvatarText}>{activeCallerInitials}</Text>
            </View>
            <Text style={styles.callName}>{callerName}</Text>
            <Text style={styles.callRelationship}>
              {activeCallContext.caller.relationship} · {activeCallVoiceOption.label}
            </Text>
            <View style={styles.turnPill}>
              <Text style={styles.turnPillText}>
                {isRealtime
                  ? 'NATURAL PHONE CALL'
                  : isConnecting
                    ? `PREPARING ${activeCallVoiceOption.label.toUpperCase()}`
                    : isRealtimeError
                      ? 'REALTIME VOICE UNAVAILABLE'
                      : `MOMENT ${Math.min(turnIndex + 1, scriptedBeatCount)} OF ${scriptedBeatCount}`}
              </Text>
            </View>
            <Waveform
              active={
                !isEnding &&
                !isCallUnavailable &&
                (callPhase === 'caller' || callPhase === 'overlap' || isListening)
              }
            />
            <Text style={styles.phaseLabel}>{phaseLabel}</Text>
            <Text style={styles.callHint}>
              {isEnding
                ? 'Opening your call recap…'
                : isConnecting
                  ? `Starting a live call with ${activeCallVoiceOption.label}.`
                : isRealtimeError
                  ? realtimeError ?? 'Check microphone access and try the call again.'
                : isRealtime && realtimeMuted
                ? 'Tap Unmute when you are ready to rejoin the call.'
                : isRealtime && callPhase === 'overlap'
                  ? `You are talking together. Keep going to take the floor, or pause and let ${callerName} finish.`
                : isRealtime && callPhase === 'caller'
                  ? `React naturally. A quick “yeah” can overlap; keep speaking to take the floor.`
                  : isRealtime
                    ? 'Your microphone is open — just talk naturally.'
                : callPhase === 'your-turn'
                  ? turnIndex === scriptedBeatCount - 1
                    ? `${callerName} has said goodbye. Say yours, then let go.`
                    : 'Respond naturally. There is no script to read.'
                  : 'Stay with the meaning, not every single word.'}
            </Text>
          </View>

          <View style={styles.callControls}>
            <View style={styles.callControlGroup}>
              <Pressable
                accessibilityLabel={
                  isCallUnavailable
                    ? 'Microphone unavailable'
                    : isRealtime
                    ? realtimeMuted
                      ? 'Unmute microphone'
                      : 'Mute microphone'
                    : 'Hold to talk'
                }
                accessibilityRole="button"
                disabled={isEnding || isCallUnavailable || (!isRealtime && !canTalk)}
                onPress={isRealtime ? toggleRealtimeMute : finishUserTurn}
                onPressIn={isRealtime ? undefined : beginUserTurn}
                onPressOut={isRealtime ? undefined : finishUserTurn}
                style={({ pressed }) => [
                  styles.micButton,
                  isRealtime && styles.phoneMicButton,
                  isRealtime && realtimeMuted && styles.phoneMicButtonMuted,
                  (isEnding || isCallUnavailable) && styles.micButtonDisabled,
                  !isRealtime && !canTalk && styles.micButtonDisabled,
                  !isRealtime && (pressed || isListening) && styles.micButtonActive,
                  isRealtime && pressed && styles.buttonPressed,
                ]}>
                {isRealtime && realtimeMuted ? (
                  <MicOff color={colors.ink} size={29} strokeWidth={2.1} />
                ) : (
                  <Mic
                    color={isRealtime || canTalk ? 'white' : 'rgba(255,255,255,0.35)'}
                    fill={!isRealtime && isListening ? 'white' : 'transparent'}
                    size={29}
                    strokeWidth={2.1}
                  />
                )}
              </Pressable>
              <Text style={styles.holdLabel}>
                {isConnecting
                  ? 'Connecting'
                  : isRealtimeError
                    ? 'Unavailable'
                    : isRealtime
                      ? realtimeMuted
                        ? 'Unmute'
                        : 'Mute'
                      : isListening
                        ? 'Listening'
                        : 'Hold to speak'}
              </Text>
            </View>
            <View style={styles.callControlGroup}>
              <Pressable
                accessibilityLabel="End call"
                accessibilityRole="button"
                disabled={isEnding}
                onPress={isCallUnavailable ? returnHome : () => finishCall()}
                style={({ pressed }) => [
                  styles.hangupButton,
                  isEnding && styles.hangupButtonDisabled,
                  pressed && !isEnding && styles.buttonPressed,
                ]}>
                <PhoneOff color="white" size={27} strokeWidth={2.2} />
              </Pressable>
              <Text style={styles.holdLabel}>{isCallUnavailable ? 'Close' : 'End'}</Text>
            </View>
          </View>
        </SafeAreaView>
      </LinearGradient>
    );
  }

  if (screen === 'receipt') {
    return (
      <SafeAreaView style={[styles.fullScreen, styles.paperBackground]}>
        <ScrollView contentContainerStyle={[styles.phoneFrame, styles.receiptContent]}>
          <View style={styles.receiptHero}>
            <View style={styles.completeIcon}>
              <Check color="white" size={24} strokeWidth={3} />
            </View>
            <Text style={styles.receiptEyebrow}>CALL COMPLETE</Text>
            <Text style={styles.receiptTitle}>{receipt.outcome}</Text>
            <Text style={styles.receiptSubtitle}>
              {activeCallContext.kind === 'reminder'
                ? 'You acknowledged the reminder and closed the call naturally.'
                : 'You handled the real-life task and kept moving.'}
            </Text>
            <View style={styles.scorePill}>
              <Text style={styles.scoreNumber}>{receipt.score}</Text>
              <Text style={styles.scoreDenominator}>/100</Text>
              <View style={styles.scoreDivider} />
              <Text style={styles.scoreLabel}>Strong response</Text>
            </View>
          </View>

          <View style={styles.receiptGroup}>
            <View style={styles.receiptSection}>
              <Text style={styles.cardEyebrow}>WHAT YOU CAUGHT</Text>
              <Text style={styles.cardBody}>{receipt.comprehension}</Text>
            </View>
            <View style={styles.sectionDivider} />
            <View style={styles.receiptSection}>
              <Text style={styles.cardEyebrow}>THE HIDDEN CUE</Text>
              <Text style={styles.cardBody}>{receipt.missedCue}</Text>
            </View>
            <View style={styles.sectionDivider} />
            <View style={styles.receiptSection}>
              <Text style={styles.cardEyebrow}>SOUND MORE NATURAL</Text>
              <Text style={styles.phraseBefore}>{receipt.originalPhrase}</Text>
              <View style={styles.phraseDivider} />
              <Text style={styles.phraseAfter}>{receipt.naturalPhrase}</Text>
            </View>
          </View>

          {!activeScheduledCall ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => answerCall(1)}
              style={({ pressed }) => [styles.replayCard, pressed && styles.buttonPressed]}>
              <View style={styles.replayIcon}>
                <RotateCcw color={colors.coral} size={21} strokeWidth={2.4} />
              </View>
              <View style={styles.replayCopy}>
                <Text style={styles.replayTitle}>Practice the tricky moment</Text>
                <Text style={styles.replaySubtitle}>{receipt.replayLabel}</Text>
              </View>
              <ChevronRight color={colors.muted} size={21} />
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="button"
            onPress={returnHome}
            style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}>
            <Text style={styles.primaryButtonText}>Done</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.fullScreen, styles.paperBackground]}>
      <ScrollView contentContainerStyle={[styles.phoneFrame, styles.homeContent]}>
        <View style={styles.brandRow}>
          <View style={styles.brandLockup}>
            <View style={styles.brandMark}>
              <Phone color={colors.paper} fill={colors.paper} size={16} strokeWidth={2} />
            </View>
            <Text style={styles.brandName}>Better Call Ryan</Text>
          </View>
          <Pressable
            accessibilityLabel="Settings"
            accessibilityRole="button"
            onPress={() => setScreen('settings')}
            style={({ pressed }) => [styles.iconButton, pressed && styles.buttonPressed]}>
            <Settings2 color={colors.ink} size={21} strokeWidth={2} />
          </Pressable>
        </View>

        <View style={styles.heroCopy}>
          <Text style={styles.eyebrow}>ENGLISH FOR REAL LIFE</Text>
          <Text style={styles.heroTitle}>English practice that calls you first.</Text>
          <Text style={styles.heroSubtitle}>
            Short, unexpected conversations that build the reflexes real life asks for.
          </Text>
        </View>

        <View style={styles.nextCallCard}>
          <View style={styles.nextCallTop}>
            <View style={styles.nextAvatar}>
              <Text style={styles.nextAvatarText}>
                {nextScheduledCall
                  ? callerInitials(nextScheduledCall.caller.name)
                  : goldenCall.caller.initials}
              </Text>
              <View style={styles.onlineDot} />
            </View>
            <View style={styles.nextCallCopy}>
              <Text style={styles.nextCallLabel}>
                {nextScheduledCall ? 'UP NEXT' : 'READY NOW'}
              </Text>
              <Text style={styles.nextCallName}>
                {nextScheduledCall ? nextScheduledCall.caller.name : goldenCall.caller.name}
              </Text>
              <Text style={styles.nextCallRelationship}>
                {nextScheduledCall
                  ? `${nextScheduledCall.caller.relationship} · ${
                      realtimeVoiceOptions.find(
                        (voice) => voice.id === nextScheduledCall.voice,
                      )?.label ?? nextScheduledCall.voice
                    }`
                  : `${goldenCall.caller.relationship} · ${selectedVoiceOption.label}`}
              </Text>
            </View>
          </View>

          <View style={styles.callWindowNote}>
            <View style={styles.windowBadge}>
              <Clock3 color={colors.greenDark} size={14} strokeWidth={2.4} />
              <Text style={styles.windowBadgeText}>
                {nextScheduledCall
                  ? `${formatScheduledCallTime(nextScheduledCall)} · ${scheduledCallCountdown(
                      nextScheduledCall,
                      nowMs,
                    )}`
                  : 'Practice call available now'}
              </Text>
            </View>
            <Text style={styles.callWindowText}>
              {nextScheduledCall
                ? nextScheduledCall.content.summary
                : 'Try the Alex practice call whenever you want a quick speaking warm-up.'}
            </Text>
          </View>
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={openIncomingCall}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}>
          <Phone color="white" fill="white" size={20} strokeWidth={2} />
          <Text style={styles.primaryButtonText}>Try a call now</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          onPress={openScheduleComposer}
          style={({ pressed }) => [
            styles.scheduleButton,
            pressed && styles.buttonPressed,
          ]}>
          <BellRing color={colors.ink} size={19} strokeWidth={2.2} />
          <Text style={styles.scheduleButtonText}>Schedule a call</Text>
        </Pressable>

        {activeScheduledCalls.length > 0 ? (
          <View style={styles.scheduledSection}>
            <View style={styles.scheduledSectionHeader}>
              <Text style={styles.scheduledSectionTitle}>SCHEDULED</Text>
              <Text style={styles.scheduledSectionCount}>{activeScheduledCalls.length}</Text>
            </View>

            {activeScheduledCalls.map((call) => {
              const voiceLabel =
                realtimeVoiceOptions.find((voice) => voice.id === call.voice)?.label ?? call.voice;
              return (
                <View key={call.id} style={styles.scheduledCallCard}>
                  <View style={styles.scheduledCallTopRow}>
                    <View
                      style={[
                        styles.callKindBadge,
                        call.kind === 'reminder' && styles.reminderKindBadge,
                      ]}>
                      <Text
                        style={[
                          styles.callKindBadgeText,
                          call.kind === 'reminder' && styles.reminderKindBadgeText,
                        ]}>
                        {call.kind === 'reminder' ? 'REMINDER' : 'PRACTICE'}
                      </Text>
                    </View>
                    <Text style={styles.scheduledCountdown}>
                      {scheduledCallCountdown(call, nowMs)}
                    </Text>
                  </View>

                  <Text style={styles.scheduledCallTitle}>{call.title}</Text>
                  <Text style={styles.scheduledCallCaller}>
                    {call.caller.name} · {call.caller.relationship} · {voiceLabel}
                  </Text>

                  <View style={styles.scheduledTimeRow}>
                    <Clock3 color={colors.muted} size={14} strokeWidth={2.2} />
                    <Text style={styles.scheduledTimeText}>{formatScheduledCallTime(call)}</Text>
                  </View>

                  <Pressable
                    accessibilityLabel={`Cancel ${call.title}`}
                    accessibilityRole="button"
                    onPress={() => cancelScheduledCall(call).catch(() => undefined)}
                    style={({ pressed }) => [
                      styles.cancelScheduledButton,
                      pressed && styles.buttonPressed,
                    ]}>
                    <Trash2 color="#C4322B" size={14} strokeWidth={2.2} />
                    <Text style={styles.cancelScheduledText}>Cancel call</Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
        ) : null}

        <View style={styles.progressCard}>
          <View>
            <Text style={styles.progressEyebrow}>THIS WEEK</Text>
            <Text style={styles.progressNumber}>{completedCalls}</Text>
            <Text style={styles.progressLabel}>calls answered</Text>
          </View>
          <View style={styles.progressRule} />
          <View style={styles.progressMessage}>
            <Text style={styles.progressMessageTitle}>
              {completedCalls === 0 ? 'Your first reflex starts here.' : 'Your speaking reflex is taking shape.'}
            </Text>
            <Text style={styles.progressMessageBody}>No streak pressure. Just answer when life calls.</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fullScreen: { flex: 1 },
  phoneFrame: {
    alignSelf: 'center',
    flex: 1,
    maxWidth: 520,
    width: '100%',
  },
  paperBackground: { backgroundColor: colors.paper },
  homeContent: {
    flexGrow: 1,
    paddingBottom: 40,
    paddingHorizontal: 22,
    paddingTop: 16,
  },
  brandRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  brandLockup: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  brandMark: {
    alignItems: 'center',
    backgroundColor: colors.ink,
    borderRadius: 11,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  brandName: { color: colors.ink, fontSize: 17, fontWeight: '700', letterSpacing: -0.35 },
  iconButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 20,
    boxShadow: '0 3px 10px rgba(0,0,0,0.06)',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  settingsContent: {
    flexGrow: 1,
    paddingBottom: 42,
    paddingHorizontal: 22,
    paddingTop: 16,
  },
  settingsNav: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  backButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 20,
    boxShadow: '0 3px 10px rgba(0,0,0,0.05)',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  settingsNavTitle: { color: colors.ink, fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  settingsNavSpacer: { height: 40, width: 40 },
  settingsHero: { marginBottom: 24, marginTop: 42 },
  settingsTitle: {
    color: colors.ink,
    fontFamily: displayFont,
    fontSize: 38,
    fontWeight: '700',
    letterSpacing: -1.4,
    lineHeight: 42,
  },
  settingsSubtitle: { color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 12 },
  voicePreviewCard: {
    alignItems: 'center',
    backgroundColor: colors.coralSoft,
    borderRadius: 18,
    flexDirection: 'row',
    marginBottom: 14,
    paddingHorizontal: 15,
    paddingVertical: 14,
  },
  voicePreviewIcon: {
    alignItems: 'center',
    backgroundColor: 'white',
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    marginRight: 12,
    width: 36,
  },
  voicePreviewCopy: { flex: 1 },
  voicePreviewLabel: {
    color: colors.coral,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  voicePreviewLine: { color: colors.ink, fontSize: 13, lineHeight: 18 },
  voiceGroup: {
    backgroundColor: colors.surface,
    borderRadius: 24,
    boxShadow: '0 10px 24px rgba(0,0,0,0.045)',
    overflow: 'hidden',
  },
  voiceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 76,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  voiceRowSelected: { backgroundColor: '#F7FBFF' },
  voiceRowPressed: { opacity: 0.68 },
  voiceIcon: {
    alignItems: 'center',
    backgroundColor: colors.paper,
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    marginRight: 13,
    width: 40,
  },
  voiceIconSelected: { backgroundColor: colors.coralSoft },
  voiceCopy: { flex: 1 },
  voiceName: { color: colors.ink, fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  voiceNote: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 3 },
  voiceCheck: {
    alignItems: 'center',
    backgroundColor: colors.coral,
    borderRadius: 10,
    height: 20,
    justifyContent: 'center',
    marginLeft: 10,
    width: 20,
  },
  voicePlaying: { backgroundColor: colors.green },
  voiceDivider: { backgroundColor: colors.border, height: 1, marginLeft: 69 },
  settingsFootnote: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 16, paddingHorizontal: 4 },
  scheduleContent: {
    flexGrow: 1,
    paddingBottom: 42,
    paddingHorizontal: 22,
    paddingTop: 16,
  },
  scheduleHero: { marginBottom: 26, marginTop: 42 },
  scheduleTitle: {
    color: colors.ink,
    fontFamily: displayFont,
    fontSize: 37,
    fontWeight: '700',
    letterSpacing: -1.35,
    lineHeight: 42,
    maxWidth: 440,
  },
  scheduleSubtitle: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 12,
    maxWidth: 430,
  },
  scheduleVoiceCard: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: 'transparent',
    borderRadius: 24,
    borderWidth: 1,
    boxShadow: '0 12px 28px rgba(0,0,0,0.055)',
    flexDirection: 'row',
    minHeight: 92,
    outlineWidth: 0,
    paddingHorizontal: 16,
    paddingVertical: 15,
  },
  scheduleVoiceCardRecording: {
    backgroundColor: '#FFF9F8',
    borderColor: 'rgba(255,59,48,0.18)',
  },
  scheduleVoiceCardBusy: { opacity: 0.76 },
  scheduleMicButton: {
    alignItems: 'center',
    backgroundColor: colors.coral,
    borderRadius: 28,
    boxShadow: '0 7px 15px rgba(0,122,255,0.22)',
    height: 56,
    justifyContent: 'center',
    marginRight: 14,
    width: 56,
  },
  scheduleMicButtonRecording: {
    backgroundColor: '#FF3B30',
    boxShadow: '0 7px 15px rgba(255,59,48,0.20)',
  },
  recordStopGlyph: { backgroundColor: 'white', borderRadius: 3, height: 17, width: 17 },
  scheduleVoiceCopy: { flex: 1 },
  scheduleVoiceTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.25,
  },
  scheduleVoiceSubtitle: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  scheduleMiniWaveform: {
    alignItems: 'center',
    height: 54,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 72,
  },
  scheduleOrRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    marginVertical: 19,
  },
  scheduleOrRule: { backgroundColor: colors.border, flex: 1, height: 1 },
  scheduleOrText: { color: '#9A9A9F', fontSize: 9, fontWeight: '700', letterSpacing: 0.8 },
  scheduleTextCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 21,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingBottom: 12,
    paddingTop: 15,
  },
  scheduleTextInput: {
    color: colors.ink,
    fontSize: 16,
    lineHeight: 23,
    minHeight: 80,
    padding: 0,
    textAlignVertical: 'top',
  },
  scheduleTextHint: { color: colors.muted, fontSize: 10, lineHeight: 15, marginTop: 9 },
  scheduleReviewButton: { marginTop: 16 },
  scheduleReviewButtonDisabled: { backgroundColor: '#B8B8BD', boxShadow: 'none' },
  scheduleErrorCard: {
    backgroundColor: '#FFF0EF',
    borderRadius: 14,
    marginTop: 12,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  scheduleErrorText: { color: '#B42318', fontSize: 12, lineHeight: 17 },
  clarificationCard: {
    backgroundColor: colors.coralSoft,
    borderRadius: 20,
    marginBottom: 14,
    paddingHorizontal: 17,
    paddingVertical: 16,
  },
  clarificationEyebrow: {
    color: colors.coral,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 7,
  },
  clarificationQuestion: {
    color: colors.ink,
    fontFamily: displayFont,
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.35,
    lineHeight: 26,
  },
  confirmationCard: {
    backgroundColor: colors.surface,
    borderRadius: 26,
    boxShadow: '0 14px 32px rgba(0,0,0,0.06)',
    padding: 19,
  },
  confirmationTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  callKindBadge: {
    backgroundColor: '#EEF7F0',
    borderRadius: 10,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  reminderKindBadge: { backgroundColor: colors.coralSoft },
  callKindBadgeText: {
    color: colors.greenDark,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.7,
  },
  reminderKindBadgeText: { color: colors.coral },
  confirmedMark: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  confirmedMarkText: {
    color: colors.greenDark,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.7,
  },
  confirmationTitle: {
    color: colors.ink,
    fontFamily: displayFont,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.75,
    lineHeight: 33,
    marginBottom: 22,
    marginTop: 14,
  },
  confirmationDetailRow: { alignItems: 'center', flexDirection: 'row' },
  confirmationIcon: {
    alignItems: 'center',
    backgroundColor: colors.coralSoft,
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    marginRight: 12,
    width: 34,
  },
  confirmationDetailCopy: { flex: 1 },
  confirmationDetailLabel: {
    color: colors.muted,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginBottom: 3,
  },
  confirmationDetailValue: { color: colors.ink, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  confirmationDivider: { backgroundColor: colors.border, height: 1, marginVertical: 15 },
  confirmationSummary: {
    backgroundColor: colors.paper,
    borderRadius: 17,
    marginTop: 18,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  confirmationSummaryText: { color: colors.ink, fontSize: 13, lineHeight: 19 },
  reminderItems: { gap: 7, marginTop: 11 },
  reminderItemRow: { alignItems: 'flex-start', flexDirection: 'row' },
  reminderItemDot: {
    backgroundColor: colors.coral,
    borderRadius: 3,
    height: 5,
    marginRight: 8,
    marginTop: 7,
    width: 5,
  },
  reminderItemText: { color: colors.muted, flex: 1, fontSize: 12, lineHeight: 18 },
  detailsConfirmedCard: {
    alignItems: 'center',
    backgroundColor: '#EDF8EF',
    borderRadius: 18,
    flexDirection: 'row',
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  detailsConfirmedIcon: {
    alignItems: 'center',
    backgroundColor: colors.green,
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    marginRight: 11,
    width: 34,
  },
  detailsConfirmedCopy: { flex: 1 },
  detailsConfirmedTitle: { color: colors.greenDark, fontSize: 13, fontWeight: '700' },
  detailsConfirmedText: { color: colors.greenDark, fontSize: 10, lineHeight: 15, marginTop: 2 },
  confirmPrimaryButton: { marginTop: 16 },
  scheduleEditButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    marginTop: 5,
  },
  scheduleEditButtonText: { color: colors.coral, fontSize: 13, fontWeight: '600' },
  heroCopy: { marginBottom: 30, marginTop: 48 },
  eyebrow: {
    color: colors.coral,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.9,
    marginBottom: 12,
  },
  heroTitle: {
    color: colors.ink,
    fontFamily: displayFont,
    fontSize: 45,
    fontWeight: '700',
    letterSpacing: -2.1,
    lineHeight: 48,
  },
  heroSubtitle: { color: colors.muted, fontSize: 17, lineHeight: 25, marginTop: 17, maxWidth: 420 },
  nextCallCard: {
    backgroundColor: colors.surface,
    borderRadius: 26,
    boxShadow: '0 10px 24px rgba(0,0,0,0.055)',
    marginBottom: 16,
    padding: 20,
  },
  nextCallTop: { alignItems: 'center', flexDirection: 'row' },
  nextAvatar: {
    alignItems: 'center',
    backgroundColor: '#F0F0F2',
    borderRadius: 27,
    height: 54,
    justifyContent: 'center',
    marginRight: 13,
    position: 'relative',
    width: 54,
  },
  nextAvatarText: { color: colors.ink, fontFamily: displayFont, fontSize: 22, fontWeight: '600' },
  onlineDot: {
    backgroundColor: colors.green,
    borderColor: colors.surface,
    borderRadius: 7,
    borderWidth: 2,
    bottom: 0,
    height: 13,
    position: 'absolute',
    right: 0,
    width: 13,
  },
  nextCallCopy: { flex: 1 },
  nextCallLabel: { color: colors.muted, fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
  nextCallName: { color: colors.ink, fontSize: 20, fontWeight: '700', letterSpacing: -0.35, marginTop: 2 },
  nextCallRelationship: { color: colors.muted, fontSize: 12, marginTop: 2 },
  windowBadge: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    marginBottom: 6,
  },
  windowBadgeText: { color: colors.greenDark, fontSize: 11, fontWeight: '700' },
  callWindowNote: {
    backgroundColor: colors.paper,
    borderRadius: 15,
    marginTop: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  callWindowText: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.coral,
    borderRadius: 18,
    boxShadow: '0 7px 16px rgba(0,122,255,0.18)',
    flexDirection: 'row',
    gap: 9,
    justifyContent: 'center',
    minHeight: 56,
    paddingHorizontal: 18,
  },
  primaryButtonText: { color: 'white', fontSize: 16, fontWeight: '700', letterSpacing: -0.1 },
  buttonPressed: { opacity: 0.78, transform: [{ scale: 0.98 }] },
  scheduleButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 18,
    flexDirection: 'row',
    gap: 9,
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 52,
    paddingHorizontal: 14,
  },
  scheduleButtonActive: { backgroundColor: colors.coralSoft },
  scheduleButtonText: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  scheduledSection: { gap: 10, marginTop: 27 },
  scheduledSectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  scheduledSectionTitle: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.9,
  },
  scheduledSectionCount: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '600',
  },
  scheduledCallCard: {
    backgroundColor: colors.surface,
    borderRadius: 21,
    boxShadow: '0 8px 20px rgba(0,0,0,0.04)',
    padding: 17,
  },
  scheduledCallTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  scheduledCountdown: { color: colors.greenDark, fontSize: 11, fontWeight: '700' },
  scheduledCallTitle: {
    color: colors.ink,
    fontFamily: displayFont,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.35,
    marginTop: 13,
  },
  scheduledCallCaller: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  scheduledTimeRow: {
    alignItems: 'center',
    backgroundColor: colors.paper,
    borderRadius: 12,
    flexDirection: 'row',
    gap: 7,
    marginTop: 13,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  scheduledTimeText: { color: colors.ink, flex: 1, fontSize: 11, fontWeight: '600' },
  cancelScheduledButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 6,
    marginTop: 13,
    minHeight: 28,
    paddingRight: 8,
  },
  cancelScheduledText: { color: '#C4322B', fontSize: 11, fontWeight: '600' },
  progressCard: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 22,
    flexDirection: 'row',
    marginTop: 22,
    padding: 18,
  },
  progressEyebrow: { color: colors.muted, fontSize: 9, fontWeight: '700', letterSpacing: 0.9 },
  progressNumber: { color: colors.ink, fontFamily: displayFont, fontSize: 34, fontWeight: '700', lineHeight: 38 },
  progressLabel: { color: colors.muted, fontSize: 11 },
  progressRule: { backgroundColor: colors.border, height: 53, marginHorizontal: 18, width: 1 },
  progressMessage: { flex: 1 },
  progressMessageTitle: { color: colors.ink, fontSize: 14, fontWeight: '600', letterSpacing: -0.1 },
  progressMessageBody: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 5 },
  ambientOrb: { borderRadius: 999, pointerEvents: 'none', position: 'absolute' },
  ambientOrbBlue: {
    backgroundColor: 'rgba(0,122,255,0.18)',
    height: 340,
    left: -160,
    top: -80,
    width: 340,
  },
  ambientOrbGreen: {
    backgroundColor: 'rgba(52,199,89,0.10)',
    bottom: -120,
    height: 360,
    right: -200,
    width: 360,
  },
  incomingTop: { alignItems: 'center', paddingTop: 18 },
  incomingTime: { color: 'rgba(255,255,255,0.56)', fontSize: 13, fontWeight: '600' },
  practiceBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: 15,
    flexDirection: 'row',
    gap: 6,
    marginTop: 16,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  practiceDot: { backgroundColor: colors.green, borderRadius: 4, height: 7, width: 7 },
  practiceBadgeText: { color: 'rgba(255,255,255,0.72)', fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  incomingIdentity: { alignItems: 'center', flex: 1, justifyContent: 'center', paddingBottom: 38 },
  pulseStage: { alignItems: 'center', height: 155, justifyContent: 'center', width: 155 },
  pulseRing: {
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 78,
    borderWidth: 1,
    height: 155,
    position: 'absolute',
    width: 155,
  },
  avatarLarge: {
    alignItems: 'center',
    backgroundColor: '#E8E9EC',
    borderRadius: 54,
    boxShadow: '0 16px 30px rgba(0,0,0,0.32)',
    height: 108,
    justifyContent: 'center',
    width: 108,
  },
  avatarLargeText: { color: colors.ink, fontFamily: displayFont, fontSize: 43, fontWeight: '500' },
  incomingName: { color: 'white', fontFamily: displayFont, fontSize: 42, fontWeight: '600', letterSpacing: -1.2, marginTop: 20 },
  incomingRelationship: { color: 'rgba(255,255,255,0.74)', fontSize: 16, marginTop: 7 },
  incomingContext: { color: 'rgba(255,255,255,0.4)', fontSize: 12, marginTop: 10 },
  incomingActions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingBottom: 44,
    paddingHorizontal: 58,
  },
  roundActionGroup: { alignItems: 'center', gap: 11 },
  roundAction: {
    alignItems: 'center',
    borderRadius: 36,
    boxShadow: '0 9px 15px rgba(0,0,0,0.24)',
    height: 72,
    justifyContent: 'center',
    width: 72,
  },
  roundActionLabel: { color: 'rgba(255,255,255,0.82)', fontSize: 12, fontWeight: '500' },
  callHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginHorizontal: 23,
    paddingTop: 20,
  },
  liveStatus: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  liveDot: { backgroundColor: colors.green, borderRadius: 4, height: 7, width: 7 },
  liveDotEnded: { backgroundColor: 'rgba(255,255,255,0.32)' },
  liveStatusText: { color: 'rgba(255,255,255,0.52)', fontSize: 9, fontWeight: '700', letterSpacing: 0.9 },
  callAvatar: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.11)',
    borderRadius: 43,
    height: 86,
    justifyContent: 'center',
    marginBottom: 18,
    width: 86,
  },
  callAvatarText: { color: 'white', fontFamily: displayFont, fontSize: 31, fontWeight: '500' },
  callName: { color: 'white', fontFamily: displayFont, fontSize: 30, fontWeight: '600', letterSpacing: -0.7 },
  callRelationship: { color: 'rgba(255,255,255,0.43)', fontSize: 13, marginTop: 5 },
  callTimer: { color: 'rgba(255,255,255,0.62)', fontSize: 13, fontVariant: ['tabular-nums'] },
  callCenter: { alignItems: 'center', flex: 1, justifyContent: 'center', paddingHorizontal: 28, paddingTop: 8 },
  turnPill: {
    backgroundColor: 'rgba(255,255,255,0.065)',
    borderRadius: 12,
    marginBottom: 22,
    marginTop: 30,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  turnPillText: { color: 'rgba(255,255,255,0.42)', fontSize: 9, fontWeight: '700', letterSpacing: 0.9 },
  phaseLabel: { color: 'white', fontFamily: displayFont, fontSize: 24, fontWeight: '600', letterSpacing: -0.5, marginTop: 22 },
  callHint: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 10,
    maxWidth: 300,
    textAlign: 'center',
  },
  callControls: { alignItems: 'flex-start', flexDirection: 'row', gap: 58, justifyContent: 'center', paddingBottom: 36 },
  callControlGroup: { alignItems: 'center' },
  micButton: {
    alignItems: 'center',
    backgroundColor: colors.coral,
    borderRadius: 36,
    height: 72,
    justifyContent: 'center',
    width: 72,
  },
  phoneMicButton: { backgroundColor: 'rgba(255,255,255,0.12)' },
  phoneMicButtonMuted: { backgroundColor: 'white' },
  micButtonDisabled: { backgroundColor: 'rgba(255,255,255,0.09)' },
  micButtonActive: { backgroundColor: colors.green, transform: [{ scale: 1.06 }] },
  holdLabel: { color: 'rgba(255,255,255,0.54)', fontSize: 12, fontWeight: '500', marginTop: 10 },
  hangupButton: {
    alignItems: 'center',
    backgroundColor: '#FF3B30',
    borderRadius: 36,
    height: 72,
    justifyContent: 'center',
    width: 72,
  },
  hangupButtonDisabled: { backgroundColor: 'rgba(255,59,48,0.38)' },
  receiptContent: { flexGrow: 1, paddingBottom: 40, paddingHorizontal: 22, paddingTop: 34 },
  receiptHero: { alignItems: 'center', marginBottom: 28 },
  completeIcon: {
    alignItems: 'center',
    backgroundColor: colors.green,
    borderRadius: 28,
    boxShadow: '0 6px 14px rgba(52,199,89,0.18)',
    height: 56,
    justifyContent: 'center',
    width: 56,
  },
  receiptEyebrow: { color: colors.muted, fontSize: 10, fontWeight: '700', letterSpacing: 0.9, marginBottom: 10, marginTop: 18 },
  receiptTitle: {
    color: colors.ink,
    fontFamily: displayFont,
    fontSize: 33,
    fontWeight: '700',
    letterSpacing: -1.1,
    lineHeight: 38,
    maxWidth: 350,
    textAlign: 'center',
  },
  receiptSubtitle: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 9, textAlign: 'center' },
  scorePill: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 18,
    flexDirection: 'row',
    marginTop: 19,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  scoreNumber: { color: colors.ink, fontFamily: displayFont, fontSize: 21, fontWeight: '700' },
  scoreDenominator: { color: colors.muted, fontSize: 12, marginLeft: 1, marginTop: 4 },
  scoreDivider: { backgroundColor: colors.border, height: 20, marginHorizontal: 12, width: 1 },
  scoreLabel: { color: colors.greenDark, fontSize: 12, fontWeight: '600' },
  receiptGroup: {
    backgroundColor: colors.surface,
    borderRadius: 22,
    overflow: 'hidden',
  },
  receiptSection: { padding: 18 },
  sectionDivider: { backgroundColor: colors.border, height: 1, marginLeft: 18 },
  cardEyebrow: { color: colors.muted, fontSize: 9, fontWeight: '700', letterSpacing: 0.9, marginBottom: 9 },
  cardBody: { color: colors.ink, fontSize: 15, lineHeight: 22 },
  phraseBefore: { color: colors.muted, fontSize: 13, lineHeight: 19, textDecorationLine: 'line-through' },
  phraseDivider: { backgroundColor: colors.border, height: 1, marginVertical: 12 },
  phraseAfter: { color: colors.coral, fontFamily: displayFont, fontSize: 18, fontWeight: '600', lineHeight: 24 },
  replayCard: {
    alignItems: 'center',
    backgroundColor: colors.coralSoft,
    borderRadius: 20,
    flexDirection: 'row',
    marginBottom: 14,
    marginTop: 18,
    padding: 16,
  },
  replayIcon: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    marginRight: 12,
    width: 40,
  },
  replayCopy: { flex: 1 },
  replayTitle: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  replaySubtitle: { color: colors.muted, fontSize: 11, marginTop: 4 },
});
