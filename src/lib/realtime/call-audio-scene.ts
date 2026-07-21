import type { CallAudioScene } from '../scheduled-call';

type SceneProfile = {
  noiseGain: number;
  noiseFilter: BiquadFilterType;
  noiseFrequency: number;
  noiseQ: number;
  rumbleFrequency: number | null;
  rumbleGain: number;
  modulationRate: number;
};

type AudioContextWindow = typeof window & {
  webkitAudioContext?: typeof AudioContext;
};

export type ActiveCallAudioScene = {
  start: () => Promise<void>;
  close: () => void;
};

const sceneProfiles: Record<CallAudioScene, SceneProfile> = {
  'quiet-room': {
    noiseGain: 0.015,
    noiseFilter: 'lowpass',
    noiseFrequency: 1_250,
    noiseQ: 0.5,
    rumbleFrequency: null,
    rumbleGain: 0,
    modulationRate: 0.07,
  },
  street: {
    noiseGain: 0.055,
    noiseFilter: 'bandpass',
    noiseFrequency: 760,
    noiseQ: 0.85,
    rumbleFrequency: 46,
    rumbleGain: 0.003,
    modulationRate: 0.11,
  },
  cafe: {
    noiseGain: 0.05,
    noiseFilter: 'bandpass',
    noiseFrequency: 1_150,
    noiseQ: 0.75,
    rumbleFrequency: 58,
    rumbleGain: 0.0016,
    modulationRate: 0.14,
  },
  car: {
    noiseGain: 0.055,
    noiseFilter: 'lowpass',
    noiseFrequency: 520,
    noiseQ: 0.55,
    rumbleFrequency: 54,
    rumbleGain: 0.004,
    modulationRate: 0.09,
  },
  office: {
    noiseGain: 0.025,
    noiseFilter: 'bandpass',
    noiseFrequency: 880,
    noiseQ: 0.8,
    rumbleFrequency: 60,
    rumbleGain: 0.001,
    modulationRate: 0.06,
  },
  gym: {
    noiseGain: 0.045,
    noiseFilter: 'bandpass',
    noiseFrequency: 690,
    noiseQ: 0.85,
    rumbleFrequency: 51,
    rumbleGain: 0.002,
    modulationRate: 0.12,
  },
};

function makeAirNoise(context: AudioContext) {
  const frameCount = context.sampleRate * 4;
  const buffer = context.createBuffer(1, frameCount, context.sampleRate);
  const channel = buffer.getChannelData(0);
  let previous = 0;

  for (let index = 0; index < frameCount; index += 1) {
    const white = Math.random() * 2 - 1;
    previous = previous * 0.94 + white * 0.06;
    channel[index] = previous * 2.2;
  }

  return buffer;
}

export function createCallAudioScene(
  scene: CallAudioScene,
): ActiveCallAudioScene | null {
  if (typeof window === 'undefined') return null;

  const AudioContextConstructor =
    window.AudioContext ?? (window as AudioContextWindow).webkitAudioContext;
  if (!AudioContextConstructor) return null;

  try {
    const context = new AudioContextConstructor();
    const profile = sceneProfiles[scene];

    const noise = context.createBufferSource();
    noise.buffer = makeAirNoise(context);
    noise.loop = true;

    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = profile.noiseFilter;
    noiseFilter.frequency.value = profile.noiseFrequency;
    noiseFilter.Q.value = profile.noiseQ;

    const noiseLevel = context.createGain();
    noiseLevel.gain.value = 0.0001;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseLevel);
    noiseLevel.connect(context.destination);

    const levelDrift = context.createOscillator();
    const levelDriftDepth = context.createGain();
    levelDrift.type = 'sine';
    levelDrift.frequency.value = profile.modulationRate;
    levelDriftDepth.gain.value = profile.noiseGain * 0.22;
    levelDrift.connect(levelDriftDepth);
    levelDriftDepth.connect(noiseLevel.gain);

    const rumble = profile.rumbleFrequency ? context.createOscillator() : null;
    const rumbleLevel = rumble ? context.createGain() : null;
    if (rumble && rumbleLevel && profile.rumbleFrequency) {
      rumble.type = 'sine';
      rumble.frequency.value = profile.rumbleFrequency;
      rumbleLevel.gain.value = profile.rumbleGain;
      rumble.connect(rumbleLevel);
      rumbleLevel.connect(context.destination);
    }

    let started = false;
    let closed = false;
    void context.resume().catch(() => undefined);

    return {
      async start() {
        if (closed) return;
        await context.resume();
        if (started) return;
        started = true;
        noise.start();
        levelDrift.start();
        rumble?.start();
        noiseLevel.gain.setTargetAtTime(profile.noiseGain, context.currentTime, 0.45);
      },
      close() {
        if (closed) return;
        closed = true;
        if (started) {
          noise.stop();
          levelDrift.stop();
          rumble?.stop();
        }
        void context.close().catch(() => undefined);
      },
    };
  } catch {
    return null;
  }
}
