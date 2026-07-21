# Better Call Ryan — Devpost draft

## Tagline

English practice that calls you before you are ready—just like real life.

## Inspiration

After seven years in the United States, I kept noticing the same gap: classroom English can prepare you for a test, but it rarely prepares you for a friend calling right after basketball, a clinic confirming an appointment, or a delivery driver asking an unexpected question.

AI voice products can already hold impressive conversations, but the learner still has to open an app, choose voice mode, invent a topic, and press start. That initiation chain turns practice into homework. Real calls work differently: they interrupt you, create a tiny amount of social pressure, and force you to understand intent quickly.

Better Call Ryan reverses the interaction. The practice calls you.

## What it does

Learners choose who may call, what kinds of situations they want, and the time windows when practice calls are allowed. Inside those safe boundaries, the exact moment and wording can stay unpredictable.

Each call is short and practical. The caller may need to coordinate dinner, change an appointment, clarify a delivery, ask for a favor, or resolve a small misunderstanding. The learner is not shown a script or live transcript. They have to listen, respond, clarify, and complete the social task.

After hanging up, the learner receives a Call Receipt instead of a generic lesson. It answers four useful questions:

1. Did the real-life task get completed?
2. What did the learner understand correctly?
3. Which hidden conversational cue did they miss?
4. What is one more natural way to say something they attempted?

The Golden Call in this prototype is Alex, a basketball friend, calling after pickup to coordinate an impromptu dinner and confirm the headcount, timing, and location.

## How we built it

The client is an Expo SDK 57 React Native app with one call state machine shared across iOS, Android, and web. Expo Notifications schedules local practice calls. Expo Audio, Speech, and Haptics provide the deterministic mobile demo and tactile call experience.

I collaborated with Codex throughout OpenAI Build Week to turn the original idea into a scoped product, iterate on the phone-first interface, implement the call and scheduling state machines, create the secure server boundary, and verify the project with typed validation, scheduler tests, linting, and a production web export. Codex also helped sharpen the product decisions that distinguish the experience from a chatbot: the caller begins in character, the microphone stays open, the live call has no transcript, and teaching waits until after the call.

For unscripted voice calls, the web adapter uses full-duplex WebRTC and OpenAI `gpt-realtime-2.1`. The microphone is open by default like a normal call, with mute/unmute and semantic-VAD interruption instead of push-to-talk. Learners can choose from all ten built-in Realtime voices before the call, with the choice stored locally and validated again at the server. A small Express service creates the Realtime session through OpenAI's unified server interface, so the standard API key never enters the app. The Realtime caller receives a private practical objective, an in-character first line, and strict role rules: initiate the situation like a real friend, never become a tutor or assistant during the call, vary pace and emphasis by meaning, and repair misunderstanding naturally.

After the call, the server sends the transcript to `gpt-5.6-sol`. Structured Outputs constrain the result to the Call Receipt schema, producing consistent outcome, comprehension, missed-cue, phrasing, and replay fields.

If the AI service is unconfigured or offline, the app automatically falls back to the deterministic Golden Call. That makes the core product experience reliable and demoable without weakening the production security boundary.

## Challenges

The hardest product decision was what not to show. Live transcripts and suggested replies make an AI demo easier, but they train reading rather than listening. We intentionally kept the call surface sparse and moved teaching into the receipt after the social moment was over.

The hardest engineering boundary was voice security. A mobile app must never contain a standard OpenAI key. We separated the trusted session and coaching APIs from the client, added privacy-preserving safety identifiers, and made failure degrade into a complete local scenario.

We also had to balance surprise with consent. The product labels every incoming event as a practice call and only schedules inside user-defined windows. It does not access contacts, impersonate real people, or place PSTN calls in this MVP.

## Accomplishments

- A complete phone-shaped loop rather than another voice chat screen
- Immediate and scheduled surprise-call paths
- An immersive, transcript-free call surface
- Deterministic fallback plus a secure Realtime integration boundary
- A structured, actionable post-call receipt
- One codebase for mobile and web

## What we learned

The valuable part of language practice is not always longer conversation. A 90-second call can train availability checks, implied meaning, turn repair, time pressure, and social closure at the same time. The product becomes more useful when the AI has a concrete private objective and the learner has a real outcome to achieve.

## What's next

1. Add the native WebRTC adapter and validate it on physical iOS and Android devices.
2. Let users create caller relationships and availability windows.
3. Generate scenario difficulty from the learner's recent receipts.
4. Add replayable 15-second moments instead of replaying whole calls.
5. Explore CallKit and Android ConnectionService only after consent, abuse prevention, and platform-review requirements are designed.

## 105-second demo script

**0:00–0:12 — The problem**  
“Voice AI is good, but I still have to open the app, pick a topic, and start practicing. Real English usually gives me no warm-up.”

**0:12–0:25 — Home**  
Show Alex and the 7:30–8:00 availability window. Tap “Schedule a demo call in 10 seconds,” then continue speaking while waiting.

**0:25–0:35 — Incoming call**  
Let the full-screen Alex call interrupt the demo. Point out the visible Practice Call label, then answer.

**0:35–1:05 — Live call**  
Let Alex open naturally. Respond with one imperfect phrase and ask Alex to repeat the question about Kevin. Show that the call stays voice-first with no transcript or suggested reply.

**1:05–1:22 — Receipt**  
Hang up. Show task completion, the meaning of “You still around?”, and the more natural version “Yeah, I can be there in about twenty.”

**1:22–1:38 — How it was built**  
“I built Better Call Ryan with Codex, which helped turn the product idea into the call state machine, scheduling flow, secure API boundary, and tested implementation. GPT Realtime powers the low-latency conversation, while GPT-5.6 Sol turns natural-language schedules and completed calls into reliable structured results.”

**1:38–1:45 — Close**  
“Better Call Ryan does not make English practice feel like homework. It makes everyday English call you first.”

## Current demo notes

- The deterministic Golden Call is the guaranteed demo path.
- Live Realtime requires `OPENAI_API_KEY` on the local server and `EXPO_PUBLIC_API_BASE_URL` in the app environment.
- Do not claim PSTN, CallKit, contact access, or native Realtime until those paths are implemented and tested.
