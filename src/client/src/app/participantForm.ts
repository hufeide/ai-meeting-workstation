export type ParticipantFormItem = {
  id: string;
  displayName: string;
};

export function createDefaultParticipants(): ParticipantFormItem[] {
  return [
    { id: "participant-a", displayName: "参与人 A" },
    { id: "participant-b", displayName: "参与人 B" }
  ];
}

export function addParticipant(participants: ParticipantFormItem[]): ParticipantFormItem[] {
  const label = String.fromCharCode(65 + participants.length);
  return [
    ...participants,
    {
      id: `participant-${Date.now()}-${participants.length}`,
      displayName: `参与人 ${label}`
    }
  ];
}

export function removeParticipant(participants: ParticipantFormItem[], id: string): ParticipantFormItem[] {
  if (participants.length <= 2) return participants;
  return participants.filter((participant) => participant.id !== id);
}

export function updateParticipant(
  participants: ParticipantFormItem[],
  id: string,
  patch: Partial<Pick<ParticipantFormItem, "displayName">>
): ParticipantFormItem[] {
  return participants.map((participant) => (participant.id === id ? { ...participant, ...patch } : participant));
}
