type FinalUtterance = {
  id: string;
  speakerLabel: string;
  text: string;
};

const ADDRESS = /^(?<polite>(?:请|麻烦)(?:问|让)?)?\s*(?:AI|ＡＩ|人工智能|会议助手|会议参谋)(?<separator>[\s，,：:、。！？!?]*)/i;
const DIRECT_REQUEST = /^(?:你(?:怎么|觉得|认为|能|可|来|说|看|帮|给|分析|评|判断|对)|请|帮我|能不能|能否|可不可以|怎么看|谈谈|说说|给我|回答)/;
const COMMAND_REQUEST = /^(?:先从|先帮|先说|先分析|分析|点评|判断|看一下|看看|解释|从.{1,30}(?:角度|方面)(?:分析|看看))/;
const UNFINISHED = /(?:尤其是|比如|包括|以及|还有|因为|然后|如果|关于|从|和|、|，|,|：|:|……|\.\.\.)$/;
const QUIET_MS = 1800;
const CONTINUATION_MS = 12_000;

export function voiceInvitationGuidance(text: string): string | null {
  const addressed = text.trim().match(ADDRESS);
  if (!addressed) return null;
  const request = text.trim().slice(addressed[0].length).trim();
  const explicitlyAddressed = Boolean(addressed.groups?.polite || /[，,：:、。！？!?]/.test(addressed.groups?.separator ?? ""));
  const hasRequest = DIRECT_REQUEST.test(request) || (explicitlyAddressed && COMMAND_REQUEST.test(request));
  return request.length >= 3 && hasRequest && !UNFINISHED.test(request) ? request.slice(0, 300) : null;
}

export class VoiceInvitationDetector {
  private candidate: { text: string; speakerLabel: string; updatedAt: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly seenFinalIds = new Set<string>();

  constructor(
    private readonly onInvite: (guidance: string) => void,
    private readonly canInvite: () => boolean
  ) {}

  onPartial(): void {
    this.clearTimer();
  }

  onFinal(utterance: FinalUtterance): void {
    if (this.seenFinalIds.has(utterance.id)) return;
    this.seenFinalIds.add(utterance.id);
    if (this.seenFinalIds.size > 200) this.seenFinalIds.clear();
    this.clearTimer();
    if (!this.canInvite()) {
      this.candidate = null;
      return;
    }

    const text = utterance.text.trim();
    const now = Date.now();
    if (ADDRESS.test(text)) {
      this.candidate = { text, speakerLabel: utterance.speakerLabel, updatedAt: now };
    } else if (
      this.candidate &&
      this.candidate.speakerLabel === utterance.speakerLabel &&
      now - this.candidate.updatedAt < CONTINUATION_MS
    ) {
      this.candidate = {
        text: `${this.candidate.text}${text}`,
        speakerLabel: utterance.speakerLabel,
        updatedAt: now
      };
    } else {
      this.candidate = null;
    }

    const guidance = this.candidate && voiceInvitationGuidance(this.candidate.text);
    if (!guidance) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.candidate = null;
      if (this.canInvite()) this.onInvite(guidance);
    }, QUIET_MS);
  }

  cancelPending(): void {
    this.clearTimer();
    this.candidate = null;
  }

  reset(): void {
    this.cancelPending();
    this.seenFinalIds.clear();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
