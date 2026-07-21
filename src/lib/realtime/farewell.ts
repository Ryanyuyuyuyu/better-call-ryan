export type FarewellTurn = {
  speaker: 'learner' | 'caller';
  text: string;
};

const directFarewell =
  /\b(?:bye(?:-bye)?|goodbye|see (?:you|ya)(?: later| soon| around)?|catch you(?: later)?|talk (?:to you )?soon|take care|have (?:a )?good one|have a (?:great|good|nice) (?:day|night|weekend)|later(?: man|dude)?)\b/i;
const reciprocalFarewell = /\b(?:you too|same to you|will do)\b/i;

export function hasDirectFarewell(text: string) {
  return directFarewell.test(text);
}

export function farewellParticipants(turns: FarewellTurn[]) {
  const participants = { learner: false, caller: false };

  for (const turn of turns) {
    const otherSpeaker = turn.speaker === 'learner' ? 'caller' : 'learner';
    if (hasDirectFarewell(turn.text)) {
      participants[turn.speaker] = true;
    } else if (reciprocalFarewell.test(turn.text) && participants[otherSpeaker]) {
      participants[turn.speaker] = true;
    }
  }

  return participants;
}

export function hasFarewellHandshake(turns: FarewellTurn[]) {
  const participants = farewellParticipants(turns);
  return participants.caller && participants.learner;
}
