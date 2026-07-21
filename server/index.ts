import 'dotenv/config';

import { createHash } from 'node:crypto';

import cors from 'cors';
import express from 'express';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { toFile } from 'openai/uploads';
import { z } from 'zod';

import { scheduledCallParseRequestSchema } from '../src/lib/scheduled-call';
import {
  goldenCallToRealtimeContext,
  realtimeCallContextSchema,
} from '../src/lib/realtime/call-context';
import {
  defaultRealtimeVoice,
  isRealtimeVoice,
  realtimeVoiceOptions,
} from '../src/lib/realtime/voices';
import { buildRealtimeInstructions } from '../src/lib/scenario-prompt';
import { parseScheduledCall } from './schedule-parser';

const app = express();
const port = Number(process.env.PORT ?? 8787);
const apiKey = process.env.OPENAI_API_KEY;
const configuredOrigin = process.env.APP_ORIGIN;
const realtimeModel = process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1';
const coachModel = process.env.OPENAI_COACH_MODEL ?? 'gpt-5.6-sol';
const transcriptionModel = process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-transcribe';

const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

app.use(
  cors({
    exposedHeaders: ['X-Caller-Voice'],
    origin(origin, callback) {
      if (!origin || origin === configuredOrigin || localOrigin.test(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  }),
);

app.get('/health', (_request, response) => {
  response.json({
    ok: true,
    aiConfigured: Boolean(apiKey),
    realtimeModel,
    coachModel,
    transcriptionModel,
    realtimeVoices: realtimeVoiceOptions.map((voice) => voice.id),
  });
});

function safetyIdentifier(request: express.Request) {
  const salt = process.env.SAFETY_ID_SALT ?? 'better-call-ryan-local-development';
  return createHash('sha256').update(`${salt}:${request.ip}`).digest('hex');
}

const realtimeSessionRequestSchema = z.object({
  sdp: z.string().min(1).max(128_000),
  call: realtimeCallContextSchema,
});

app.post(
  '/v1/realtime/session',
  express.json({ type: 'application/json', limit: '192kb' }),
  express.text({ type: ['application/sdp', 'text/plain'], limit: '128kb' }),
  async (request, response) => {
    if (!apiKey) {
      response.status(503).type('text/plain').send('OPENAI_API_KEY is not configured.');
      return;
    }

    const requestedVoice = request.header('X-Caller-Voice');
    const callerVoice = isRealtimeVoice(requestedVoice)
      ? requestedVoice
      : defaultRealtimeVoice;
    const isVoicePreview = request.header('X-Voice-Preview') === 'true';
    response.setHeader('X-Caller-Voice', callerVoice);

    let sdp: string;
    let callContext = goldenCallToRealtimeContext();
    if (isVoicePreview && typeof request.body === 'string' && request.body) {
      sdp = request.body;
    } else if (typeof request.body === 'string' && request.body) {
      // Preserve compatibility with older clients while they refresh.
      sdp = request.body;
    } else {
      const parsed = realtimeSessionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).type('text/plain').send('A valid SDP offer and call are required.');
        return;
      }
      sdp = parsed.data.sdp;
      callContext = parsed.data.call;
    }

    const form = new FormData();
    form.set('sdp', sdp);
    form.set(
      'session',
      JSON.stringify(
        isVoicePreview
          ? {
              type: 'realtime',
              model: realtimeModel,
              reasoning: { effort: 'low' },
              instructions:
                'You are demonstrating one voice option. Read only the requested preview line with natural conversational delivery.',
              audio: { output: { voice: callerVoice } },
            }
          : {
              type: 'realtime',
              model: realtimeModel,
              reasoning: { effort: 'low' },
              instructions: buildRealtimeInstructions(callContext),
              audio: {
                input: {
                  transcription: { model: 'gpt-4o-transcribe' },
                  turn_detection: {
                    type: 'semantic_vad',
                    eagerness: 'auto',
                    create_response: false,
                    interrupt_response: false,
                  },
                },
                output: { voice: callerVoice },
              },
              tools: [
                {
                  type: 'function',
                  name: 'complete_call',
                  description:
                    'End the phone call only after the practical objective is complete and both caller and learner have exchanged a natural closing cue or goodbye. Never call this after task completion alone.',
                  parameters: {
                    type: 'object',
                    properties: {
                      outcome: {
                        type: 'string',
                        description: 'A short factual description of what was decided.',
                      },
                    },
                    required: ['outcome'],
                    additionalProperties: false,
                  },
                },
              ],
              tool_choice: 'auto',
            },
      ),
    );

    try {
      const upstream = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'OpenAI-Safety-Identifier': safetyIdentifier(request),
        },
        body: form,
      });
      const body = await upstream.text();
      if (!upstream.ok) {
        console.error(
          `Realtime upstream rejected the session (${upstream.status}, voice=${callerVoice}): ${body}`,
        );
      }
      response.status(upstream.status).type(upstream.headers.get('content-type') ?? 'application/sdp').send(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown upstream error';
      console.error('Realtime session error:', message);
      response.status(502).type('text/plain').send('Could not start the realtime call.');
    }
  },
);

app.post(
  '/v1/scheduled-calls/parse',
  express.json({ limit: '32kb' }),
  async (request, response) => {
    if (!apiKey) {
      response.status(503).json({ error: 'OPENAI_API_KEY is not configured.' });
      return;
    }

    const parsed = scheduledCallParseRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: 'Invalid scheduled call request.',
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const openai = new OpenAI({ apiKey });
      const result = await parseScheduledCall(openai, coachModel, parsed.data);
      response.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown OpenAI error';
      console.error('Scheduled call parsing error:', message);
      response.status(502).json({ error: 'Could not understand the scheduled call.' });
    }
  },
);

const audioExtensionByType: Record<string, string> = {
  'audio/flac': 'flac',
  'audio/m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/x-m4a': 'm4a',
  'video/mp4': 'mp4',
};

app.post(
  '/v1/transcriptions',
  express.raw({
    type: ['audio/*', 'video/mp4', 'application/octet-stream'],
    limit: '20mb',
  }),
  async (request, response) => {
    if (!apiKey) {
      response.status(503).json({ error: 'OPENAI_API_KEY is not configured.' });
      return;
    }

    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      response.status(400).json({ error: 'An audio recording is required.' });
      return;
    }

    const contentType =
      request.get('content-type')?.split(';', 1)[0]?.trim() || 'application/octet-stream';
    const extension = audioExtensionByType[contentType] ?? 'webm';

    try {
      const openai = new OpenAI({ apiKey });
      const file = await toFile(request.body, `scheduled-call.${extension}`, {
        type: contentType,
      });
      const transcription = await openai.audio.transcriptions.create({
        file,
        model: transcriptionModel,
        prompt:
          'The speaker is scheduling a phone call. Preserve dates, clock times, time ranges, names, places, and list items exactly. The speaker may use English or Chinese.',
      });
      const text = transcription.text.trim();
      if (!text) {
        response.status(422).json({ error: 'No speech was detected.' });
        return;
      }
      response.json({ text });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown OpenAI error';
      console.error('Transcription error:', message);
      response.status(502).json({ error: 'Could not transcribe the recording.' });
    }
  },
);

const transcriptTurn = z.object({
  speaker: z.enum(['learner', 'caller']),
  text: z.string().min(1).max(2_000),
});

const receiptInput = z.object({
  call: realtimeCallContextSchema,
  turns: z.array(transcriptTurn).min(1).max(80),
});

const receiptOutput = z.object({
  outcome: z.string(),
  score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe('A whole-number score on a 0-to-100 scale, never a 0-to-1 scale.'),
  comprehension: z.string(),
  missedCue: z.string(),
  originalPhrase: z.string(),
  naturalPhrase: z.string(),
  replayLabel: z.string(),
});

app.post('/v1/receipt', express.json({ limit: '96kb' }), async (request, response) => {
  if (!apiKey) {
    response.status(503).json({ error: 'OPENAI_API_KEY is not configured.' });
    return;
  }

  const parsed = receiptInput.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'Invalid transcript.', details: parsed.error.flatten() });
    return;
  }

  const transcript = parsed.data.turns
    .map(
      (turn) =>
        `${turn.speaker === 'learner' ? 'LEARNER' : parsed.data.call.caller.name.toUpperCase()}: ${turn.text}`,
    )
    .join('\n');

  try {
    const openai = new OpenAI({ apiKey });
    const result = await openai.responses.parse({
      model: coachModel,
      input: [
        {
          role: 'system',
          content:
            'You create a concise, encouraging post-call receipt for an adult non-native English speaker. Evaluate task completion and comprehension, not accent. Give exactly one useful missed cue and one natural phrasing upgrade. Never shame or overpraise. The score must be a whole number from 0 to 100: 90–100 means the practical objective was completed clearly, 75–89 means mostly completed, 60–74 means partially completed, and below 60 means a major communication breakdown. Never return a 0-to-1 score.',
        },
        {
          role: 'user',
          content: `Call title: ${parsed.data.call.title}\nCall kind: ${parsed.data.call.kind}\nScenario: ${parsed.data.call.context}\nObjective: ${parsed.data.call.objective}\n\nTranscript:\n${transcript}`,
        },
      ],
      text: {
        format: zodTextFormat(receiptOutput, 'call_receipt'),
      },
    });

    if (!result.output_parsed) {
      response.status(502).json({ error: 'The coach did not return a receipt.' });
      return;
    }

    response.json(result.output_parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown OpenAI error';
    console.error('Receipt generation error:', message);
    response.status(502).json({ error: 'Could not generate the call receipt.' });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Better Call Ryan API listening on http://localhost:${port}`);
  if (!apiKey) console.log('Scripted demo mode: OPENAI_API_KEY is not configured.');
});
