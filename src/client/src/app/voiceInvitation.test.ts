import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceInvitationDetector, voiceInvitationGuidance } from "./voiceInvitation";

describe("spoken AI invitation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("extracts an explicitly addressed question without treating ordinary AI discussion as an invitation", () => {
    expect(voiceInvitationGuidance("AI，你怎么看这个方案？")).toBe("你怎么看这个方案？");
    expect(voiceInvitationGuidance("请 AI 分析一下合同风险。")).toBe("分析一下合同风险。");
    expect(voiceInvitationGuidance("我们讨论一下 AI 对业务的影响。")).toBeNull();
    expect(voiceInvitationGuidance("AI 会改变这个行业。")).toBeNull();
    expect(voiceInvitationGuidance("AI可以提高效率。")).toBeNull();
    expect(voiceInvitationGuidance("AI分析用户数据。")).toBeNull();
    expect(voiceInvitationGuidance("AI，先从成本角度分析，尤其是")).toBeNull();
  });

  it("waits for a continued request before inviting and sends only one invitation", () => {
    const onInvite = vi.fn();
    const detector = new VoiceInvitationDetector(onInvite, () => true);

    detector.onFinal({ id: "one", speakerLabel: "speaker_0", text: "AI，" });
    vi.advanceTimersByTime(2000);
    expect(onInvite).not.toHaveBeenCalled();

    detector.onFinal({ id: "two", speakerLabel: "speaker_0", text: "你怎么看这个方案？" });
    detector.onFinal({ id: "two", speakerLabel: "speaker_0", text: "你怎么看这个方案？" });
    vi.advanceTimersByTime(1799);
    expect(onInvite).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onInvite).toHaveBeenCalledExactlyOnceWith("你怎么看这个方案？");
  });

  it("waits through a mid-sentence pause and cancels when another speaker starts", () => {
    const onInvite = vi.fn();
    const detector = new VoiceInvitationDetector(onInvite, () => true);

    detector.onFinal({ id: "one", speakerLabel: "speaker_0", text: "AI，先从成本角度分析" });
    vi.advanceTimersByTime(1000);
    detector.onPartial();
    vi.advanceTimersByTime(2000);
    expect(onInvite).not.toHaveBeenCalled();

    detector.onFinal({ id: "two", speakerLabel: "speaker_0", text: "尤其是下季度的预算。" });
    vi.advanceTimersByTime(1800);
    expect(onInvite).toHaveBeenCalledExactlyOnceWith("先从成本角度分析尤其是下季度的预算。");

    detector.onFinal({ id: "three", speakerLabel: "speaker_0", text: "AI，请看看交付风险。" });
    detector.onPartial();
    detector.onFinal({ id: "four", speakerLabel: "speaker_1", text: "我先补充一下。" });
    vi.advanceTimersByTime(1800);
    expect(onInvite).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending voice invitation on manual action or stopped recording", () => {
    const onInvite = vi.fn();
    let available = true;
    const detector = new VoiceInvitationDetector(onInvite, () => available);

    detector.onFinal({ id: "one", speakerLabel: "speaker_0", text: "AI，你怎么看？" });
    detector.cancelPending();
    vi.advanceTimersByTime(1800);
    expect(onInvite).not.toHaveBeenCalled();

    detector.onFinal({ id: "two", speakerLabel: "speaker_0", text: "AI，你怎么看？" });
    available = false;
    vi.advanceTimersByTime(1800);
    expect(onInvite).not.toHaveBeenCalled();
  });
});
