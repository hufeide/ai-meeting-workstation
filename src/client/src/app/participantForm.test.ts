import { describe, expect, it } from "vitest";
import { addParticipant, createDefaultParticipants, removeParticipant, updateParticipant } from "./participantForm";

describe("participant form state", () => {
  it("starts with two generic participants", () => {
    expect(createDefaultParticipants().map((participant) => participant.displayName)).toEqual(["参与人 A", "参与人 B"]);
  });

  it("adds and edits participants", () => {
    const participants = addParticipant(createDefaultParticipants());
    const edited = updateParticipant(participants, participants[2]!.id, {
      displayName: "参与人 C"
    });

    expect(edited).toHaveLength(3);
    expect(edited[2]).toMatchObject({ displayName: "参与人 C" });
  });

  it("keeps at least two participants", () => {
    const participants = createDefaultParticipants();

    expect(removeParticipant(participants, participants[0]!.id)).toHaveLength(2);
    expect(removeParticipant(addParticipant(participants), participants[0]!.id).map((participant) => participant.displayName)).toEqual([
      "参与人 B",
      "参与人 C"
    ]);
  });
});
