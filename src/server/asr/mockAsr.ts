import type { DiscussionRepository } from "../discussions/repository";
import type { EventHub } from "../ws/eventHub";

const mockLines = [
  { speakerLabel: "speaker_0", text: "我觉得这个产品第一版最重要的是让讨论不要断流，AI 先不用自动插话。" },
  { speakerLabel: "speaker_1", text: "对，而且说话人一定要清楚，否则 Codex 很难判断我们两个人的观点差异。" },
  { speakerLabel: "speaker_0", text: "如果先用手动触发，工程复杂度会低很多，后面再研究动态参与。" },
  { speakerLabel: "speaker_1", text: "我还希望结束以后能回到 Codex 继续做方案，这样讨论才真的沉淀下来。" }
];

export class MockAsrService {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly repository: DiscussionRepository,
    private readonly eventHub: EventHub
  ) {}

  start(discussionId: string): void {
    if (this.timers.has(discussionId)) return;

    let index = 0;
    const timer = setInterval(() => {
      const line = mockLines[index % mockLines.length];
      const startMs = index * 5000;
      const partial = this.repository.addUtterance({
        discussionId,
        speakerLabel: line.speakerLabel,
        text: `${line.text.slice(0, Math.max(8, Math.floor(line.text.length / 2)))}...`,
        startMs,
        endMs: startMs + 2500,
        isFinal: false,
        source: "mock"
      });
      this.eventHub.publish(discussionId, { type: "transcript.partial", utterance: partial });

      setTimeout(() => {
        const final = this.repository.addUtterance({
          discussionId,
          speakerLabel: line.speakerLabel,
          text: line.text,
          startMs,
          endMs: startMs + 4500,
          isFinal: true,
          source: "mock"
        });
        this.eventHub.publish(discussionId, { type: "transcript.final", utterance: final });
      }, 450);

      index += 1;
      if (index >= mockLines.length * 2) {
        this.stop(discussionId);
      }
    }, 1800);

    this.timers.set(discussionId, timer);
    this.eventHub.publish(discussionId, { type: "asr.status", status: "connected" });
  }

  stop(discussionId: string): void {
    const timer = this.timers.get(discussionId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(discussionId);
    }
    this.eventHub.publish(discussionId, { type: "asr.status", status: "idle" });
  }
}
