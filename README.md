# Better Call Ryan

Better Call Ryan is a mobile-first speaking reflex trainer for non-native English speakers. It does not wait inside a chat box. A friend, coworker, landlord, clinic, or other everyday caller contacts the learner inside a safe availability window, gives them a short practical situation to handle, and leaves a focused call receipt afterward.

The current Golden Call is Alex, a basketball friend, calling after pickup to coordinate an impromptu dinner. The complete experience includes:

- an immediate call and a delayed surprise-call path;
- a full-screen incoming call instead of a chat interface;
- a full-duplex, open-microphone call with no visible transcript or script;
- an in-character caller who initiates the real-life situation instead of waiting for a prompt;
- a practical objective, natural repair behavior, and a short ending;
- a post-call receipt focused on comprehension, hidden cues, and one natural phrasing upgrade;
- a deterministic demo fallback, so the product remains presentable without an API key.

## Stack

- Expo SDK 57, React Native, TypeScript, and Expo Router
- Expo Notifications for scheduled local calls
- Expo Audio and Speech for the deterministic mobile demo
- OpenAI `gpt-realtime-2.1` for unscripted, interruptible speech-to-speech calls
- OpenAI `gpt-4o-transcribe` for voice-first call scheduling input
- OpenAI `gpt-5.6-sol` with Structured Outputs for call direction and receipts
- Express for the small trusted API boundary

The standard OpenAI key stays on the server. The client sends its WebRTC SDP offer to the local API, and the API creates the Realtime session through OpenAI's unified `/v1/realtime/calls` interface.

The scheduling flow records or accepts a typed request, sends audio through `POST /v1/transcriptions`, and sends the resulting text through `POST /v1/scheduled-calls/parse`. It converts natural-language reminder or practice-call requests into a validated `ScheduledCallDraft`, resolves relative times against an explicit IANA time zone, and asks a clarification question instead of guessing when a usable time is missing. Confirmed calls are saved locally with the chosen Realtime voice and a stable delivery time. Exact calls show a live countdown; call windows preserve the surprise once the window opens. Native builds register a silent local notification, while Home provides the persistent scheduled list and cancellation controls.

When a saved call becomes due, the focused app instance claims it and opens the full incoming-call screen with that call's caller, relationship, title, and voice. Answering sends a validated, bounded call context alongside the browser's WebRTC SDP to the trusted API server. The server turns that context into role-locked Realtime instructions, so reminder calls immediately deliver the reminder and practice calls immediately enter their real-life situation. The persisted lifecycle advances through `scheduled`, `ringing`, `in_call`, and `completed` or `missed`; an unanswered incoming screen times out after 35 seconds.

## How Codex and GPT-5.6 contributed

This project was designed and built in collaboration with Codex during OpenAI Build Week. Codex accelerated the work from product framing through implementation and verification: turning the original phone-first language-practice idea into a scoped MVP, iterating on the Apple-inspired call interface, implementing the call and scheduling state machines, creating the trusted Realtime API boundary, and adding typed validation, scheduler tests, linting, and web-export checks.

The collaboration also shaped several key decisions:

- The AI caller starts in character with a concrete private objective instead of asking, “How can I help you?”
- The learner gets an open-microphone, transcript-free call rather than a push-to-talk chat experience.
- Scheduling combines voice-first input with an explicit confirmation step, so surprise never removes consent.
- Teaching waits until after the call and appears as a concise Call Receipt, keeping the live conversation immersive.
- API credentials remain on the trusted server, and the MVP clearly separates simulated in-app calls from future PSTN or CallKit work.

GPT-5.6 Sol is used behind the trusted API for structured reasoning tasks. It converts natural-language scheduling requests into validated reminder or practice-call drafts and turns completed-call transcripts into schema-constrained receipts covering task outcome, comprehension, missed conversational cues, and one natural phrasing improvement. Realtime speech itself uses `gpt-realtime-2.1`; keeping these responsibilities separate gives the live call low-latency audio while using GPT-5.6 for the parts that benefit most from careful reasoning and reliable structured output.

## Run the deterministic demo

Requirements: Node.js 22+ and pnpm.

```bash
pnpm install
pnpm web
```

Open `http://localhost:8081`. Choose **Try a call now** for the Golden Call, or open **Schedule a call** to create, confirm, review, and cancel a reminder or practice call. The same UI runs on iOS and Android through Expo; a development build is recommended for native notification testing.

## Enable live OpenAI calls

Create a local environment file and add your own API key:

```bash
cp .env.example .env
```

Then run the API and app in separate terminals:

```bash
pnpm server
pnpm web
```

When `OPENAI_API_KEY` and `EXPO_PUBLIC_API_BASE_URL` are available, the web call surface attempts a live full-duplex Realtime call. The microphone stays open like a normal phone call, with mute/unmute as the primary control and automatic interruption handling through semantic VAD. If Realtime cannot connect, the call surface reports the problem instead of silently substituting a different voice. Never name an API key with the `EXPO_PUBLIC_` prefix.

The Settings screen offers all ten built-in Realtime voices and stores the selection locally. `marin` remains the default, while `marin` and `cedar` are marked as OpenAI's recommended quality choices. The caller prompt also varies pacing by meaning: casual setup can move faster, exact logistics slow slightly, and short pauses, emphasis, backchannels, and at most one natural self-repair keep the delivery from settling into a uniform assistant cadence.

For a physical phone, set `EXPO_PUBLIC_API_BASE_URL` to the computer's LAN address, such as `http://192.168.1.20:8787`. Native Realtime media transport is the next adapter; the mobile build uses a short scenario-specific deterministic fallback while notifications, recording, haptics, status transitions, and the full incoming-call flow remain native. Browser calls use the dynamic Realtime scenario.

## Project map

```text
src/app/index.tsx                  call experience and state machine
src/lib/golden-call.ts             deterministic scenario contract
src/lib/scheduled-call.ts          reminder/practice scheduling contract
src/lib/scenario-prompt.ts         Realtime caller behavior contract
src/lib/notifications.ts           local incoming-call scheduling
src/lib/realtime/call-context.ts   validated Golden/scheduled call context
src/lib/realtime/web-realtime.ts   browser WebRTC adapter
server/schedule-parser.ts           natural-language scheduling parser
server/index.ts                    Realtime session + GPT-5.6 API routes
```

## Verify

```bash
pnpm check
pnpm test:scheduler
pnpm exec expo export --platform web
```

`pnpm check` runs strict TypeScript checking and Expo ESLint. The API exposes `GET /health`; it reports whether the OpenAI key is configured without revealing it.

## Product boundaries for the MVP

This build simulates a call inside the app. It does not place PSTN calls, impersonate real people, access the user's contacts, or use iOS CallKit/Android ConnectionService yet. Those features require separate consent, platform review, and abuse controls. Practice calls are always labeled as practice calls before answering, while the conversation itself stays immersive.
