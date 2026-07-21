import { z } from 'zod';

import { realtimeVoiceOptions, type RealtimeVoice } from './realtime/voices';

export const scheduledCallsStorageKey = 'betterCallRyan.scheduledCalls.v1';

export const scheduledCallKindSchema = z.enum(['reminder', 'practice']);
export type ScheduledCallKind = z.infer<typeof scheduledCallKindSchema>;

export const callAudioSceneSchema = z.enum([
  'quiet-room',
  'street',
  'cafe',
  'car',
  'office',
  'gym',
]);
export type CallAudioScene = z.infer<typeof callAudioSceneSchema>;

export const callerEnergySchema = z.enum(['low', 'medium', 'high']);
export type CallerEnergy = z.infer<typeof callerEnergySchema>;

export const scheduledCallTriggerSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('exact'),
    at: z.string().datetime({ offset: true }),
  }),
  z.object({
    mode: z.literal('window'),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
  }),
]);
export type ScheduledCallTrigger = z.infer<typeof scheduledCallTriggerSchema>;

export const scheduledCallDraftSchema = z.object({
  schemaVersion: z.literal(1),
  kind: scheduledCallKindSchema,
  sourceText: z.string().min(1).max(2_000),
  title: z.string().min(1).max(120),
  timeZone: z.string().min(1).max(100),
  trigger: scheduledCallTriggerSchema,
  callLanguage: z.string().min(2).max(35),
  caller: z.object({
    name: z.string().min(1).max(80),
    relationship: z.string().min(1).max(120),
    personality: z
      .string()
      .min(1)
      .max(240)
      .default('easygoing, warm, and direct'),
    speechStyle: z
      .string()
      .min(1)
      .max(240)
      .default('casual short turns with uneven conversational pacing'),
    accentNote: z
      .string()
      .min(1)
      .max(160)
      .default('casual General American English with ordinary reductions'),
    signaturePhrases: z.array(z.string().min(1).max(60)).max(3).default([]),
    energy: callerEnergySchema.default('medium'),
  }),
  audioScene: callAudioSceneSchema.default('quiet-room'),
  content: z.object({
    summary: z.string().min(1).max(1_000),
    objective: z.string().min(1).max(1_000),
    reminderItems: z.array(z.string().min(1).max(240)).max(30),
  }),
});
export type ScheduledCallDraft = z.infer<typeof scheduledCallDraftSchema>;

export const scheduledCallStatusSchema = z.enum([
  'scheduled',
  'ringing',
  'in_call',
  'completed',
  'cancelled',
  'missed',
]);

export const scheduledCallSchema = scheduledCallDraftSchema.extend({
  id: z.string().min(1).max(160),
  status: scheduledCallStatusSchema,
  scheduledFor: z.string().datetime({ offset: true }),
  voice: z.enum(realtimeVoiceOptions.map((voice) => voice.id)),
  notificationId: z.string().min(1).max(500).nullable(),
  ringingOwner: z.string().min(1).max(160).nullable().default(null),
  ringingStartedAt: z.string().datetime({ offset: true }).nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ScheduledCall = z.infer<typeof scheduledCallSchema>;

function newScheduledCallId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `call-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function resolveScheduledFor(
  draft: ScheduledCallDraft,
  now = new Date(),
  random: () => number = Math.random,
) {
  if (draft.trigger.mode === 'exact') {
    const at = new Date(draft.trigger.at);
    if (at.getTime() <= now.getTime()) {
      throw new Error('That time has already passed. Choose a future time.');
    }
    return at.toISOString();
  }

  const startsAt = new Date(draft.trigger.startsAt).getTime();
  const endsAt = new Date(draft.trigger.endsAt).getTime();
  const earliest = Math.max(startsAt, now.getTime());
  if (endsAt <= earliest) {
    throw new Error('That call window has already ended. Choose a future window.');
  }

  const normalizedRandom = Math.min(Math.max(random(), 0), 0.999999999);
  return new Date(earliest + Math.floor((endsAt - earliest) * normalizedRandom)).toISOString();
}

export function createScheduledCall(
  draft: ScheduledCallDraft,
  voice: RealtimeVoice,
  options: { now?: Date; random?: () => number; id?: string } = {},
): ScheduledCall {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();

  return scheduledCallSchema.parse({
    ...draft,
    id: options.id ?? newScheduledCallId(),
    status: 'scheduled',
    scheduledFor: resolveScheduledFor(draft, now, options.random),
    voice,
    notificationId: null,
    ringingOwner: null,
    ringingStartedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function isValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

export const scheduledCallParseRequestSchema = z.object({
  text: z.string().trim().min(1).max(2_000),
  timeZone: z
    .string()
    .min(1)
    .max(100)
    .refine(isValidTimeZone, 'timeZone must be a valid IANA time zone.'),
  referenceTime: z.string().datetime({ offset: true }).optional(),
  locale: z.string().min(2).max(35).default('en-US'),
  defaultCallLanguage: z.string().min(2).max(35).default('en-US'),
});
export type ScheduledCallParseRequest = z.input<typeof scheduledCallParseRequestSchema>;
export type ValidatedScheduledCallParseRequest = z.output<
  typeof scheduledCallParseRequestSchema
>;

const understoodScheduleSchema = z.object({
  kind: scheduledCallKindSchema,
  title: z.string().min(1).max(120),
});

export const scheduledCallParseResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    draft: scheduledCallDraftSchema,
  }),
  z.object({
    status: z.literal('needs_clarification'),
    question: z.string().min(1).max(500),
    understood: understoodScheduleSchema,
  }),
]);
export type ScheduledCallParseResult = z.infer<typeof scheduledCallParseResultSchema>;
