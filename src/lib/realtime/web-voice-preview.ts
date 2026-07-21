import type { RealtimeVoice } from './voices';

type VoicePreviewCallbacks = {
  onPlaying: () => void;
  onEnded: () => void;
  onError: () => void;
};

export type WebVoicePreview = {
  close: () => void;
};

type RealtimePreviewEvent = {
  type?: string;
};

export async function startWebRealtimeVoicePreview(
  apiBaseUrl: string,
  voice: RealtimeVoice,
  previewLine: string,
  callbacks: VoicePreviewCallbacks,
): Promise<WebVoicePreview> {
  if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined') {
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
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let playingNotified = false;

  const notifyPlaying = () => {
    if (playingNotified || closed) return;
    playingNotified = true;
    callbacks.onPlaying();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (finishTimer) clearTimeout(finishTimer);
    peer.close();
    remoteAudio.pause();
    remoteAudio.srcObject = null;
  };

  try {
    remoteAudio.autoplay = true;
    remoteAudio.setAttribute('playsinline', 'true');
    peer.addTransceiver('audio', { direction: 'recvonly' });
    peer.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
      remoteAudio
        .play()
        .then(notifyPlaying)
        .catch(() => undefined);
    };

    const events = peer.createDataChannel('oai-preview-events');
    events.addEventListener('open', () => {
      events.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            instructions: `Read this line exactly once: “${previewLine}” Do not add or remove any words. Deliver it like a relaxed friend on a quick phone call: start casually, move a little faster through “we're grabbing food in a bit,” then slow slightly on the final question. Do not sound like an announcer or assistant.`,
          },
        }),
      );
    });
    events.addEventListener('message', (message) => {
      let event: RealtimePreviewEvent;
      try {
        event = JSON.parse(String(message.data)) as RealtimePreviewEvent;
      } catch {
        return;
      }

      if (event.type === 'response.output_audio.delta') notifyPlaying();
      if (event.type === 'error') {
        callbacks.onError();
        close();
      }
      if (event.type === 'response.done') {
        finishTimer = setTimeout(() => {
          callbacks.onEnded();
          close();
        }, 900);
      }
    });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await fetch(`${baseUrl}/v1/realtime/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sdp',
        'X-Caller-Voice': voice,
        'X-Voice-Preview': 'true',
      },
      body: offer.sdp,
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Voice preview failed with status ${response.status}.`);
    }
    if (response.headers.get('X-Caller-Voice') !== voice) {
      throw new Error('The Realtime server did not apply the selected preview voice.');
    }

    await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    return { close };
  } catch (error) {
    close();
    throw error instanceof Error ? error : new Error('Could not preview this voice.');
  }
}
