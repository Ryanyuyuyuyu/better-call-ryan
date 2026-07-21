export const realtimeVoiceOptions = [
  { id: 'marin', label: 'Marin', recommended: true },
  { id: 'cedar', label: 'Cedar', recommended: true },
  { id: 'alloy', label: 'Alloy', recommended: false },
  { id: 'ash', label: 'Ash', recommended: false },
  { id: 'ballad', label: 'Ballad', recommended: false },
  { id: 'coral', label: 'Coral', recommended: false },
  { id: 'echo', label: 'Echo', recommended: false },
  { id: 'sage', label: 'Sage', recommended: false },
  { id: 'shimmer', label: 'Shimmer', recommended: false },
  { id: 'verse', label: 'Verse', recommended: false },
] as const;

export type RealtimeVoice = (typeof realtimeVoiceOptions)[number]['id'];

export const defaultRealtimeVoice: RealtimeVoice = 'marin';
export const realtimeVoiceStorageKey = 'betterCallRyan.realtimeVoice.v2';
export const legacyRealtimeVoiceStorageKey = 'realtimeVoice';

export const realtimeVoicePreviewLine =
  "Yo, you still around? We're grabbing food in a bit—you coming?";

export function isRealtimeVoice(value: string | null | undefined): value is RealtimeVoice {
  return realtimeVoiceOptions.some((voice) => voice.id === value);
}
