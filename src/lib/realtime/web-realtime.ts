import type { RealtimeVoice } from './voices';
import { farewellParticipants, hasFarewellHandshake } from './farewell';
import type { RealtimeCallContext } from './call-context';
import { createCallAudioScene, type ActiveCallAudioScene } from './call-audio-scene';

export type RealtimePhase = 'caller' | 'your-turn' | 'thinking' | 'overlap';

export const naturalOverlapGraceMs = 650;

export type TranscriptTurn = {
  speaker: 'learner' | 'caller';
  text: string;
};

type RealtimeCallbacks = {
  onPhase: (phase: RealtimePhase) => void;
  onComplete: (outcome?: string) => void;
  onError: (error: Error) => void;
};

export type WebRealtimeCall = {
  setMuted: (muted: boolean) => void;
  getTranscript: () => TranscriptTurn[];
  close: () => void;
};

type RealtimeEvent = {
  type?: string;
  transcript?: string;
  delta?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
};

export async function startWebRealtimeCall(
  apiBaseUrl: string,
  callbacks: RealtimeCallbacks,
  call: RealtimeCallContext,
  voice: RealtimeVoice,
  primedAudioScene: ActiveCallAudioScene | null = null,
): Promise<WebRealtimeCall> {
  if (typeof window === 'undefined' || !navigator.mediaDevices) {
    throw new Error('WebRTC is not available in this environment.');
  }

  const baseUrl = apiBaseUrl.replace(/\/$/, '');
  const healthResponse = await fetch(`${baseUrl}/health`);
  const health = (await healthResponse.json()) as { aiConfigured?: boolean };
  if (!healthResponse.ok || !health.aiConfigured) {
    throw new Error('The Realtime server is not configured.');
  }

  const peer = new RTCPeerConnection();
  const remoteAudio = document.createElement('audio');
  const audioScene = primedAudioScene ?? createCallAudioScene(call.audioScene);
  const transcript: TranscriptTurn[] = [];
  let microphone: MediaStream | null = null;
  let completed = false;
  let pendingOutcome: string | undefined;
  let closingRepairSent = false;
  let responseActive = false;
  let responseRequested = false;
  let audioPlaybackActive = false;
  let userSpeaking = false;
  let pendingUserResponse = false;
  let overlapTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    remoteAudio.autoplay = true;
    remoteAudio.setAttribute('playsinline', 'true');
    peer.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
      audioScene?.start().catch(() => undefined);
      remoteAudio.play().catch(() => undefined);
    };

    microphone = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const microphoneTrack = microphone.getAudioTracks()[0];
    microphoneTrack.enabled = false;
    peer.addTrack(microphoneTrack, microphone);

    const events = peer.createDataChannel('oai-events');
    const clearOverlapTimer = () => {
      if (!overlapTimer) return;
      clearTimeout(overlapTimer);
      overlapTimer = null;
    };
    const createResponse = (
      instructions?: string,
      phase: RealtimePhase = 'thinking',
    ) => {
      if (completed || responseActive || responseRequested || audioPlaybackActive) {
        return false;
      }
      responseRequested = true;
      callbacks.onPhase(phase);
      events.send(
        JSON.stringify(
          instructions
            ? { type: 'response.create', response: { instructions } }
            : { type: 'response.create' },
        ),
      );
      return true;
    };
    const createQueuedUserResponse = () => {
      if (
        !pendingUserResponse ||
        responseActive ||
        responseRequested ||
        audioPlaybackActive ||
        completed
      ) {
        return false;
      }
      pendingUserResponse = false;
      return createResponse();
    };
    const completeAfterFarewell = () => {
      if (completed || pendingOutcome === undefined || !hasFarewellHandshake(transcript)) {
        return false;
      }
      completed = true;
      callbacks.onComplete(pendingOutcome);
      return true;
    };

    const requestNaturalGoodbye = () => {
      if (closingRepairSent || completed || pendingOutcome === undefined) return;
      const participants = farewellParticipants(transcript);
      if (participants.caller) {
        callbacks.onPhase('your-turn');
        return;
      }
      closingRepairSent = createResponse(
        'Do not end the call yet. In character, say one brief, natural goodbye that fits the conversation, then stop and wait for the learner to say goodbye too. Do not mention this instruction or call complete_call again in this turn.',
        'caller',
      );
    };

    events.addEventListener('open', () => {
      microphoneTrack.enabled = true;
      createResponse(
        'The learner has just answered your call. Begin speaking now and follow the FIRST FIVE SECONDS rule from your session instructions exactly. Stay in character, use no preamble, and never ask how you can help.',
        'caller',
      );
    });
    events.addEventListener('message', (message) => {
      let event: RealtimeEvent;
      try {
        event = JSON.parse(String(message.data)) as RealtimeEvent;
      } catch {
        return;
      }

      if (event.type === 'response.created') {
        responseRequested = false;
        responseActive = true;
        callbacks.onPhase(userSpeaking ? 'overlap' : 'caller');
      } else if (event.type === 'response.output_audio.delta') {
        callbacks.onPhase(userSpeaking ? 'overlap' : 'caller');
      }

      if (event.type === 'output_audio_buffer.started') {
        audioPlaybackActive = true;
        callbacks.onPhase(userSpeaking ? 'overlap' : 'caller');
      }

      if (
        event.type === 'output_audio_buffer.stopped' ||
        event.type === 'output_audio_buffer.cleared'
      ) {
        audioPlaybackActive = false;
        clearOverlapTimer();
        if (createQueuedUserResponse()) return;
        if (pendingOutcome !== undefined) {
          if (!completeAfterFarewell()) requestNaturalGoodbye();
        } else {
          callbacks.onPhase('your-turn');
        }
      }

      if (event.type === 'input_audio_buffer.speech_started') {
        userSpeaking = true;
        clearOverlapTimer();

        if (responseActive || responseRequested || audioPlaybackActive) {
          callbacks.onPhase('overlap');
          overlapTimer = setTimeout(() => {
            overlapTimer = null;
            if (
              !userSpeaking ||
              (!responseActive && !responseRequested && !audioPlaybackActive) ||
              completed
            ) {
              return;
            }
            events.send(JSON.stringify({ type: 'response.cancel' }));
            events.send(JSON.stringify({ type: 'output_audio_buffer.clear' }));
            callbacks.onPhase('your-turn');
          }, naturalOverlapGraceMs);
        } else {
          callbacks.onPhase('your-turn');
        }
      }

      if (event.type === 'input_audio_buffer.speech_stopped') {
        userSpeaking = false;
        clearOverlapTimer();
        callbacks.onPhase(
          responseActive || responseRequested || audioPlaybackActive ? 'caller' : 'thinking',
        );
      }

      if (event.type === 'input_audio_buffer.committed') {
        pendingUserResponse = true;
        createQueuedUserResponse();
      }

      if (
        event.type === 'conversation.item.input_audio_transcription.completed' &&
        event.transcript
      ) {
        transcript.push({ speaker: 'learner', text: event.transcript });
        completeAfterFarewell();
      }

      if (event.type === 'response.output_audio_transcript.done' && event.transcript) {
        transcript.push({ speaker: 'caller', text: event.transcript });
        completeAfterFarewell();
      }

      if (event.type === 'response.function_call_arguments.done' && event.name === 'complete_call') {
        try {
          const args = JSON.parse(event.arguments ?? '{}') as { outcome?: string };
          pendingOutcome = args.outcome?.trim() || 'You completed the call.';
        } catch {
          pendingOutcome = 'You completed the call.';
        }
        if (!completeAfterFarewell() && event.call_id) {
          events.send(
            JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: event.call_id,
                output: JSON.stringify({
                  status: 'deferred',
                  reason: 'Wait until both people have exchanged a natural farewell.',
                }),
              },
            }),
          );
        }
      } else if (event.type === 'response.done' && !completed) {
        responseActive = false;
        responseRequested = false;
        if (!audioPlaybackActive) clearOverlapTimer();
        if (createQueuedUserResponse()) {
          return;
        }
        if (pendingOutcome !== undefined) {
          if (!completeAfterFarewell()) requestNaturalGoodbye();
        } else if (!audioPlaybackActive) {
          callbacks.onPhase('your-turn');
        }
      }
    });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await fetch(`${baseUrl}/v1/realtime/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Caller-Voice': voice,
      },
      body: JSON.stringify({ sdp: offer.sdp, call }),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Realtime session failed with status ${response.status}.`);
    }
    if (response.headers.get('X-Caller-Voice') !== voice) {
      throw new Error('The Realtime server did not apply the selected voice.');
    }

    await peer.setRemoteDescription({
      type: 'answer',
      sdp: await response.text(),
    });

    return {
      setMuted(muted) {
        microphoneTrack.enabled = !muted;
      },
      getTranscript() {
        return [...transcript];
      },
      close() {
        clearOverlapTimer();
        microphone?.getTracks().forEach((track) => track.stop());
        events.close();
        peer.close();
        audioScene?.close();
        remoteAudio.srcObject = null;
      },
    };
  } catch (error) {
    if (overlapTimer) clearTimeout(overlapTimer);
    microphone?.getTracks().forEach((track) => track.stop());
    peer.close();
    audioScene?.close();
    const normalized = error instanceof Error ? error : new Error('Could not start Realtime.');
    callbacks.onError(normalized);
    throw normalized;
  }
}
