import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';

import {
  scheduledCallDraftSchema,
  type ScheduledCallParseResult,
  type ValidatedScheduledCallParseRequest,
} from '../src/lib/scheduled-call';

const modelScheduleOutputSchema = z.object({
  status: z.enum(['ready', 'needs_clarification']),
  clarificationQuestion: z.string().nullable(),
  kind: z.enum(['reminder', 'practice']),
  title: z.string(),
  triggerMode: z.enum(['exact', 'window']).nullable(),
  scheduledAt: z.string().nullable(),
  windowStartsAt: z.string().nullable(),
  windowEndsAt: z.string().nullable(),
  callLanguage: z.string(),
  callerName: z.string().nullable(),
  callerRelationship: z.string().nullable(),
  callerPersonality: z.string(),
  callerSpeechStyle: z.string(),
  callerAccentNote: z.string(),
  callerSignaturePhrases: z.array(z.string()).max(3),
  callerEnergy: z.enum(['low', 'medium', 'high']),
  audioScene: z.enum(['quiet-room', 'street', 'cafe', 'car', 'office', 'gym']),
  summary: z.string(),
  objective: z.string(),
  reminderItems: z.array(z.string()),
});

type ModelScheduleOutput = z.infer<typeof modelScheduleOutputSchema>;

function fallbackClarification(locale: string) {
  return locale.toLowerCase().startsWith('zh')
    ? '你希望这通电话在什么具体时间打来？'
    : 'What specific time should this call arrive?';
}

function validFutureInstant(value: string | null, referenceTime: Date) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() < referenceTime.getTime() - 30_000) return null;
  return parsed.toISOString();
}

export function normalizeScheduleOutput(
  output: ModelScheduleOutput,
  request: ValidatedScheduledCallParseRequest,
  referenceTime: Date,
): ScheduledCallParseResult {
  const understood = {
    kind: output.kind,
    title: output.title.trim() || (output.kind === 'reminder' ? 'Reminder call' : 'Practice call'),
  };

  if (output.status === 'needs_clarification' || !output.triggerMode) {
    return {
      status: 'needs_clarification',
      question: output.clarificationQuestion?.trim() || fallbackClarification(request.locale),
      understood,
    };
  }

  const exactAt = validFutureInstant(output.scheduledAt, referenceTime);
  const windowStartsAt = validFutureInstant(output.windowStartsAt, referenceTime);
  const windowEndsAt = validFutureInstant(output.windowEndsAt, referenceTime);

  const trigger =
    output.triggerMode === 'exact' && exactAt
      ? { mode: 'exact' as const, at: exactAt }
      : output.triggerMode === 'window' && windowStartsAt && windowEndsAt
        ? {
            mode: 'window' as const,
            startsAt: windowStartsAt,
            endsAt: windowEndsAt,
          }
        : null;

  if (
    !trigger ||
    (trigger.mode === 'window' &&
      new Date(trigger.endsAt).getTime() <= new Date(trigger.startsAt).getTime())
  ) {
    return {
      status: 'needs_clarification',
      question: output.clarificationQuestion?.trim() || fallbackClarification(request.locale),
      understood,
    };
  }

  const draft = scheduledCallDraftSchema.parse({
    schemaVersion: 1,
    kind: output.kind,
    sourceText: request.text,
    title: understood.title,
    timeZone: request.timeZone,
    trigger,
    callLanguage: output.callLanguage.trim() || request.defaultCallLanguage,
    caller: {
      name: output.callerName?.trim() || 'Alex',
      relationship: output.callerRelationship?.trim() || 'Friend',
      personality: output.callerPersonality.trim() || 'easygoing, warm, and direct',
      speechStyle:
        output.callerSpeechStyle.trim() ||
        'casual short turns with uneven conversational pacing',
      accentNote:
        output.callerAccentNote.trim() ||
        'casual General American English with ordinary reductions',
      signaturePhrases: output.callerSignaturePhrases
        .map((phrase) => phrase.trim())
        .filter(Boolean)
        .slice(0, 3),
      energy: output.callerEnergy,
    },
    audioScene: output.audioScene,
    content: {
      summary: output.summary.trim(),
      objective: output.objective.trim(),
      reminderItems: output.kind === 'reminder' ? output.reminderItems : [],
    },
  });

  return { status: 'ready', draft };
}

function parserInstructions(
  request: ValidatedScheduledCallParseRequest,
  referenceTime: Date,
) {
  const localReference = new Intl.DateTimeFormat(request.locale, {
    dateStyle: 'full',
    timeStyle: 'long',
    timeZone: request.timeZone,
  }).format(referenceTime);

  return `You convert a user's natural-language request into a scheduled AI phone call.

Reference instant (UTC): ${referenceTime.toISOString()}
Reference local time: ${localReference}
IANA time zone: ${request.timeZone}
Default spoken call language: ${request.defaultCallLanguage}

Rules:
- Classify a call as "reminder" only when its primary job is to help the user remember something, such as "remind me", "提醒我", or "别让我忘记".
- Classify a call as "practice" when the user asks a person, department, friend, or other role to call and enact a situation. Requests such as "让篮球朋友打给我约晚饭", "假装房东打给我", and "simulate a clinic calling me" are practice calls even when they usefully coordinate something.
- A random call inside a window is not automatically practice; determine the kind from the call's purpose and requested role.
- Use "exact" when the user names one time or a relative delay. Use "window" only when the user gives a range or asks for an unpredictable time within a range.
- Resolve relative phrases such as "in one hour" from the reference instant.
- Return all timestamps as absolute ISO 8601 UTC strings ending in Z.
- If a clock time has already passed locally and the user did not name a date, choose the next future occurrence.
- Never invent a missing clock time. If a usable future time or window cannot be resolved, set status to "needs_clarification" and ask one short question in the user's language.
- Keep the title concise and in the user's language.
- The spoken call language defaults to ${request.defaultCallLanguage}, but honor an explicit language request.
- Extract concrete reminder items without translating proper names unnecessarily. reminderItems must be empty for practice calls.
- For reminder calls, describe what the caller should remind the user about. For practice calls, describe the role and real-life objective.
- Use Alex as callerName and Friend as callerRelationship unless the user explicitly requests another role or identity.
- Give every caller a compact, believable vocal identity that can remain stable when the call happens:
  - callerPersonality: two or three socially relevant traits, not a biography.
  - callerSpeechStyle: natural volume, tempo, cadence, or conversational habits. Make it specific and imperfect rather than polished.
  - callerAccentNote: a light, plausible American regional or social speech influence. Never infer ethnicity, nationality, gender, disability, or socioeconomic status. Avoid caricature and phonetic spellings.
  - callerSignaturePhrases: zero to three ordinary fillers or pet phrases that fit this individual. They are occasional habits, not catchphrases to repeat every turn.
  - callerEnergy: low, medium, or high for the situation.
- Choose audioScene from quiet-room, street, cafe, car, office, or gym based on where this caller would plausibly be. This is ambient context, not a story detail that the caller must explain.
- Vary the default caller texture across requests. Do not make every Alex an upbeat, perfectly articulate General American speaker. Keep the result believable and respectful.
- Nullable time fields that do not match triggerMode must be null.
- Do not add advice, commentary, or information that the user did not provide.`;
}

export async function parseScheduledCall(
  openai: OpenAI,
  model: string,
  request: ValidatedScheduledCallParseRequest,
) {
  const referenceTime = request.referenceTime ? new Date(request.referenceTime) : new Date();
  const result = await openai.responses.parse({
    model,
    reasoning: { effort: 'low' },
    input: [
      {
        role: 'system',
        content: parserInstructions(request, referenceTime),
      },
      {
        role: 'user',
        content: request.text,
      },
    ],
    text: {
      format: zodTextFormat(modelScheduleOutputSchema, 'scheduled_call_intent'),
    },
  });

  if (!result.output_parsed) {
    throw new Error('The scheduler did not return a structured result.');
  }

  return normalizeScheduleOutput(result.output_parsed, request, referenceTime);
}
