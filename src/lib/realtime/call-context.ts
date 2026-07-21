import { z } from 'zod';

import { goldenCall, type GoldenCallScenario } from '../golden-call';
import { callAudioSceneSchema, callerEnergySchema, type ScheduledCall } from '../scheduled-call';

export const realtimeCallContextSchema = z.object({
  callId: z.string().min(1).max(160),
  source: z.enum(['golden', 'scheduled']),
  kind: z.enum(['reminder', 'practice']),
  title: z.string().min(1).max(120),
  callLanguage: z.string().min(2).max(35),
  caller: z.object({
    name: z.string().min(1).max(80),
    relationship: z.string().min(1).max(120),
    accentNote: z.string().min(1).max(160),
    personality: z.string().min(1).max(240),
    speechStyle: z.string().min(1).max(240),
    signaturePhrases: z.array(z.string().min(1).max(60)).max(3),
    energy: callerEnergySchema,
  }),
  audioScene: callAudioSceneSchema,
  context: z.string().min(1).max(1_000),
  objective: z.string().min(1).max(1_000),
  mission: z.array(z.string().min(1).max(240)).min(1).max(30),
  openingLine: z.string().min(1).max(500).nullable(),
  targetDurationSeconds: z.number().int().min(20).max(300),
});
export type RealtimeCallContext = z.infer<typeof realtimeCallContextSchema>;

export function goldenCallToRealtimeContext(
  scenario: GoldenCallScenario = goldenCall,
): RealtimeCallContext {
  return realtimeCallContextSchema.parse({
    callId: scenario.id,
    source: 'golden',
    kind: 'practice',
    title: 'Dinner after basketball',
    callLanguage: 'en-US',
    caller: scenario.caller,
    audioScene: scenario.audioScene,
    context: scenario.context,
    objective: scenario.hiddenObjective,
    mission: scenario.userMission,
    openingLine: scenario.beats[0]?.callerLine ?? null,
    targetDurationSeconds: scenario.targetDurationSeconds,
  });
}

export function scheduledCallToRealtimeContext(
  call: ScheduledCall,
): RealtimeCallContext {
  const reminderMission =
    call.content.reminderItems.length > 0
      ? call.content.reminderItems.map((item) => `Acknowledge the reminder item: ${item}`)
      : [`Acknowledge the reminder about ${call.title}`];

  return realtimeCallContextSchema.parse({
    callId: call.id,
    source: 'scheduled',
    kind: call.kind,
    title: call.title,
    callLanguage: call.callLanguage,
    caller: {
      ...call.caller,
    },
    audioScene: call.audioScene,
    context: call.content.summary,
    objective: call.content.objective,
    mission: call.kind === 'reminder' ? reminderMission : [call.content.objective],
    openingLine: null,
    targetDurationSeconds: call.kind === 'reminder' ? 45 : 90,
  });
}
