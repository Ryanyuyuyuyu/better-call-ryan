import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createScheduledCall,
  scheduledCallDraftSchema,
  scheduledCallParseRequestSchema,
  type ScheduledCallDraft,
} from '../src/lib/scheduled-call';
import { scheduledCallToRealtimeContext } from '../src/lib/realtime/call-context';
import { buildRealtimeInstructions } from '../src/lib/scenario-prompt';
import { normalizeScheduleOutput } from './schedule-parser';

const request = {
  text: '一小时后提醒我买胡萝卜、西兰花和牛肉',
  timeZone: 'Asia/Shanghai',
  referenceTime: '2026-07-20T02:00:00.000Z',
  locale: 'zh-CN',
  defaultCallLanguage: 'en-US',
};

const callerTexture = {
  callerPersonality: 'warm, lightly distracted, and direct',
  callerSpeechStyle: 'medium-low volume with quick bursts and uneven pauses',
  callerAccentNote: 'casual West Coast English',
  callerSignaturePhrases: ['yeah, no', 'you know'],
  callerEnergy: 'medium' as const,
  audioScene: 'street' as const,
};

test('normalizes an exact reminder call', () => {
  const result = normalizeScheduleOutput(
    {
      status: 'ready',
      clarificationQuestion: null,
      kind: 'reminder',
      title: '买菜提醒',
      triggerMode: 'exact',
      scheduledAt: '2026-07-20T03:00:00.000Z',
      windowStartsAt: null,
      windowEndsAt: null,
      callLanguage: 'en-US',
      callerName: null,
      callerRelationship: null,
      ...callerTexture,
      summary: 'Remind Ryan to buy groceries.',
      objective: 'Make sure Ryan remembers all three grocery items.',
      reminderItems: ['胡萝卜', '西兰花', '牛肉'],
    },
    request,
    new Date(request.referenceTime),
  );

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.deepEqual(result.draft.trigger, {
    mode: 'exact',
    at: '2026-07-20T03:00:00.000Z',
  });
  assert.deepEqual(result.draft.content.reminderItems, ['胡萝卜', '西兰花', '牛肉']);
  assert.equal(result.draft.caller.name, 'Alex');
  assert.equal(result.draft.audioScene, 'street');
  assert.deepEqual(result.draft.caller.signaturePhrases, ['yeah, no', 'you know']);
});

test('normalizes a practice call window', () => {
  const result = normalizeScheduleOutput(
    {
      status: 'ready',
      clarificationQuestion: null,
      kind: 'practice',
      title: '篮球朋友约晚饭',
      triggerMode: 'window',
      scheduledAt: null,
      windowStartsAt: '2026-07-20T11:30:00.000Z',
      windowEndsAt: '2026-07-20T12:00:00.000Z',
      callLanguage: 'en-US',
      callerName: 'Alex',
      callerRelationship: 'Basketball friend',
      ...callerTexture,
      summary: 'A basketball friend calls about dinner.',
      objective: 'Agree on whether and when to meet for dinner.',
      reminderItems: ['should be discarded'],
    },
    request,
    new Date(request.referenceTime),
  );

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.draft.trigger.mode, 'window');
  assert.deepEqual(result.draft.content.reminderItems, []);
});

test('asks for clarification instead of inventing a missing time', () => {
  const result = normalizeScheduleOutput(
    {
      status: 'needs_clarification',
      clarificationQuestion: '你希望明天几点打给你？',
      kind: 'reminder',
      title: '买菜提醒',
      triggerMode: null,
      scheduledAt: null,
      windowStartsAt: null,
      windowEndsAt: null,
      callLanguage: 'en-US',
      callerName: null,
      callerRelationship: null,
      ...callerTexture,
      summary: 'Remind Ryan to buy groceries.',
      objective: 'Remind Ryan about groceries.',
      reminderItems: ['胡萝卜'],
    },
    { ...request, text: '明天提醒我买胡萝卜' },
    new Date(request.referenceTime),
  );

  assert.deepEqual(result, {
    status: 'needs_clarification',
    question: '你希望明天几点打给你？',
    understood: { kind: 'reminder', title: '买菜提醒' },
  });
});

test('rejects a reversed call window', () => {
  const result = normalizeScheduleOutput(
    {
      status: 'ready',
      clarificationQuestion: null,
      kind: 'practice',
      title: '晚饭电话',
      triggerMode: 'window',
      scheduledAt: null,
      windowStartsAt: '2026-07-20T12:00:00.000Z',
      windowEndsAt: '2026-07-20T11:30:00.000Z',
      callLanguage: 'en-US',
      callerName: null,
      callerRelationship: null,
      ...callerTexture,
      summary: 'A friend calls about dinner.',
      objective: 'Make dinner plans.',
      reminderItems: [],
    },
    request,
    new Date(request.referenceTime),
  );

  assert.equal(result.status, 'needs_clarification');
});

test('rejects an invalid IANA time zone before calling the model', () => {
  const result = scheduledCallParseRequestSchema.safeParse({
    text: 'Remind me in an hour',
    timeZone: 'Somewhere/Imaginary',
  });

  assert.equal(result.success, false);
});

const draftFixture: ScheduledCallDraft = {
  schemaVersion: 1,
  kind: 'reminder',
  sourceText: 'Remind me to buy groceries tomorrow.',
  title: 'Grocery reminder',
  timeZone: 'Asia/Shanghai',
  trigger: { mode: 'exact', at: '2026-07-21T03:00:00.000Z' },
  callLanguage: 'en-US',
  caller: {
    name: 'Alex',
    relationship: 'Personal reminder caller',
    personality: callerTexture.callerPersonality,
    speechStyle: callerTexture.callerSpeechStyle,
    accentNote: callerTexture.callerAccentNote,
    signaturePhrases: callerTexture.callerSignaturePhrases,
    energy: callerTexture.callerEnergy,
  },
  audioScene: callerTexture.audioScene,
  content: {
    summary: 'Remind Ryan to buy groceries.',
    objective: 'Make sure Ryan remembers the grocery list.',
    reminderItems: ['carrots', 'broccoli', 'beef'],
  },
};

test('adds safe personality defaults to calls saved by the previous schema', () => {
  const migrated = scheduledCallDraftSchema.parse({
    schemaVersion: 1,
    kind: 'practice',
    sourceText: 'Call me tomorrow morning.',
    title: 'Morning call',
    timeZone: 'Asia/Shanghai',
    trigger: { mode: 'exact', at: '2026-07-21T01:00:00.000Z' },
    callLanguage: 'en-US',
    caller: { name: 'Alex', relationship: 'Friend' },
    content: {
      summary: 'A friend calls in the morning.',
      objective: 'Make a plan for the day.',
      reminderItems: [],
    },
  });

  assert.equal(migrated.audioScene, 'quiet-room');
  assert.equal(migrated.caller.energy, 'medium');
  assert.match(migrated.caller.speechStyle, /uneven conversational pacing/);
});

test('creates a persistable exact scheduled call with its selected voice', () => {
  const call = createScheduledCall(draftFixture, 'cedar', {
    id: 'call-exact',
    now: new Date('2026-07-20T03:00:00.000Z'),
  });

  assert.equal(call.id, 'call-exact');
  assert.equal(call.status, 'scheduled');
  assert.equal(call.scheduledFor, '2026-07-21T03:00:00.000Z');
  assert.equal(call.voice, 'cedar');
  assert.equal(call.notificationId, null);
});

test('resolves a surprise-call window to one stable fire time', () => {
  const call = createScheduledCall(
    {
      ...draftFixture,
      kind: 'practice',
      trigger: {
        mode: 'window',
        startsAt: '2026-07-20T03:30:00.000Z',
        endsAt: '2026-07-20T04:00:00.000Z',
      },
    },
    'marin',
    {
      id: 'call-window',
      now: new Date('2026-07-20T03:00:00.000Z'),
      random: () => 0.5,
    },
  );

  assert.equal(call.scheduledFor, '2026-07-20T03:45:00.000Z');
});

test('builds a role-locked Realtime reminder from a scheduled call', () => {
  const call = createScheduledCall(draftFixture, 'marin', {
    id: 'call-realtime',
    now: new Date('2026-07-20T03:00:00.000Z'),
  });
  const context = scheduledCallToRealtimeContext(call);
  const instructions = buildRealtimeInstructions(context);

  assert.equal(context.callId, 'call-realtime');
  assert.equal(context.kind, 'reminder');
  assert.match(instructions, /immediately give the reminder itself/i);
  assert.match(instructions, /Never open with “How can I help you\?”/);
  assert.match(instructions, /carrots/);
  assert.match(instructions, /casual West Coast English/);
  assert.match(instructions, /medium-low volume with quick bursts/);
  assert.match(instructions, /calling from outside on a street/);
  assert.match(instructions, /both people .*exchanged closing cues/i);
});
