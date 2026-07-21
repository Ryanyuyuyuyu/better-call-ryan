export type CallBeat = {
  id: string;
  callerLine: string;
  privateIntent: string;
};

export type GoldenCallScenario = {
  id: string;
  caller: {
    name: string;
    initials: string;
    relationship: string;
    accentNote: string;
    personality: string;
    speechStyle: string;
    signaturePhrases: string[];
    energy: 'low' | 'medium' | 'high';
  };
  audioScene: 'quiet-room' | 'street' | 'cafe' | 'car' | 'office' | 'gym';
  context: string;
  hiddenObjective: string;
  userMission: string[];
  targetDurationSeconds: number;
  beats: CallBeat[];
  receipt: {
    outcome: string;
    score: number;
    comprehension: string;
    missedCue: string;
    originalPhrase: string;
    naturalPhrase: string;
    replayLabel: string;
  };
};

export const goldenCall: GoldenCallScenario = {
  id: 'after-basketball-dinner',
  caller: {
    name: 'Alex',
    initials: 'A',
    relationship: 'Basketball friend',
    accentNote: 'Casual Midwest English',
    personality: 'easygoing, lightly teasing, and a little distracted after the game',
    speechStyle:
      'medium-low volume, quick bursts of speech, then slower when confirming logistics',
    signaturePhrases: ['yeah, no', 'I mean', 'like'],
    energy: 'medium',
  },
  audioScene: 'gym',
  context: 'Alex calls after pickup basketball to coordinate an impromptu dinner.',
  hiddenObjective:
    'Confirm whether the learner is joining, whether Kevin is coming, and whether the group should wait before leaving.',
  userMission: [
    'Understand that the group is getting food',
    'Say whether you are joining',
    'Clarify Kevin’s plans',
    'Confirm the time and place',
  ],
  targetDurationSeconds: 95,
  beats: [
    {
      id: 'opener',
      callerLine:
        "Yo, where'd you disappear to? We're thinking about grabbing food. You still around?",
      privateIntent: 'Find out whether the learner is available and interested.',
    },
    {
      id: 'headcount',
      callerLine:
        "Sweet. It's me, Marcus, and probably Tasha. Do you know if Kevin is still at the gym, or did he head home too?",
      privateIntent: 'Get an accurate headcount without sounding formal.',
    },
    {
      id: 'logistics',
      callerLine:
        "No worries. We're heading to that taco place on State. Think you can make it in, like, twenty minutes?",
      privateIntent: 'Confirm timing and whether the group needs to wait.',
    },
    {
      id: 'close',
      callerLine:
        "Perfect. Text me if Kevin's coming too so I can grab a table. See you in a bit.",
      privateIntent: 'Close with one clear follow-up action.',
    },
  ],
  receipt: {
    outcome: 'Dinner plans confirmed',
    score: 86,
    comprehension:
      'You caught the plan, answered the timing question, and kept the exchange moving.',
    missedCue:
      '“You still around?” meant “Are you nearby and free?”, not literally asking where you are standing.',
    originalPhrase: 'I think I can arrive there after twenty minutes.',
    naturalPhrase: 'Yeah, I can be there in about twenty.',
    replayLabel: 'The headcount question about Kevin',
  },
};
