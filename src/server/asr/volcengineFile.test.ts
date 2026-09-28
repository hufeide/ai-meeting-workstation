import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/database";
import { DiscussionRepository } from "../discussions/repository";
import { VolcengineFileTranscriber, mapVolcengineFileError, normalizeVolcengineFileSpeaker } from "./volcengineFile";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("VolcengineFileTranscriber", () => {
  it("sends a base64 audio payload and writes returned utterances into the existing timeline", async () => {
    const { repository, storagePaths, discussionId } = createFixture();
    let queryCount = 0;
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Api-Key")).toBe("test-key");
      expect(headers.get("X-Api-Resource-Id")).toBe("volc.seedasr.auc");
      if (String(url).endsWith("/submit")) {
        const body = JSON.parse(String(init?.body)) as {
          user: { uid: string };
          audio: { data: string; format: string };
          request: { show_utterances: boolean; enable_speaker_info: boolean };
        };
        expect(headers.get("X-Api-Sequence")).toBe("-1");
        expect(body.audio).toEqual({ data: Buffer.from("synthetic wav").toString("base64"), format: "wav" });
        expect(body.user.uid).toBe("meeting-workstation-local");
        expect(body.request.show_utterances).toBe(true);
        expect(body.request.enable_speaker_info).toBe(true);
        return new Response("{}", {
          status: 200,
          headers: { "X-Api-Status-Code": "20000000", "X-Api-Message": "OK" }
        });
      }
      queryCount += 1;
      if (queryCount === 1) {
        return new Response("{}", {
          status: 200,
          headers: { "X-Api-Status-Code": "20000001", "X-Api-Message": "Processing" }
        });
      }
      return new Response(JSON.stringify({
        result: {
          text: "第一句。第二句。",
          utterances: [
            { text: "第一句。", start_time: 100, end_time: 800, additions: { speaker: "1" } },
            { text: "第二句。", start_time: 900, end_time: 1600, additions: { speaker: "2" } }
          ]
        }
      }), {
        status: 200,
        headers: { "X-Api-Status-Code": "20000000", "X-Api-Message": "OK" }
      });
    });
    const transcriber = new VolcengineFileTranscriber(
      { repository, storagePaths },
      { apiKey: "test-key", fetch: request as typeof fetch }
    );

    const result = await transcriber.transcribeUpload({
      discussionId,
      filename: "meeting.wav",
      audio: Buffer.from("synthetic wav")
    });
    const discussion = repository.getDiscussionOrThrow(discussionId);

    expect(request).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ transcript: "第一句。第二句。", utteranceCount: 2 });
    expect(readFileSync(result.transcriptPath, "utf8")).toBe("第一句。第二句。\n");
    expect(discussion.utterances).toEqual([
      expect.objectContaining({ text: "第一句。", speakerLabel: "speaker_0", startMs: 100, endMs: 800, source: "volcengine-file" }),
      expect.objectContaining({ text: "第二句。", speakerLabel: "speaker_1", startMs: 900, endMs: 1600, source: "volcengine-file" })
    ]);
    expect(discussion.audioAssets).toHaveLength(1);
  });

  it("rejects missing credentials and unsupported local formats before any network call", async () => {
    const { repository, storagePaths, discussionId } = createFixture();
    const request = vi.fn();
    const missingKey = new VolcengineFileTranscriber({ repository, storagePaths }, { fetch: request as typeof fetch });
    const unsupported = new VolcengineFileTranscriber(
      { repository, storagePaths },
      { apiKey: "test-key", fetch: request as typeof fetch }
    );

    await expect(missingKey.transcribeUpload({ discussionId, filename: "test.wav", audio: Buffer.from("x") }))
      .rejects.toThrow("缺少火山 ASR API Key");
    await expect(unsupported.transcribeUpload({ discussionId, filename: "test.flac", audio: Buffer.from("x") }))
      .rejects.toThrow("不支持该格式");
    expect(request).not.toHaveBeenCalled();
  });

  it("maps cloud permission failures to an actionable message", () => {
    expect(mapVolcengineFileError(403, "45000000", "permission denied"))
      .toContain("已开通 volc.seedasr.auc");
  });

  it("normalizes Volcengine file speaker groups to the existing zero-based labels", () => {
    expect([1, 2, 3, 4].map((speaker) => normalizeVolcengineFileSpeaker({ additions: { speaker } })))
      .toEqual(["speaker_0", "speaker_1", "speaker_2", "speaker_3"]);
    expect(normalizeVolcengineFileSpeaker({ additions: { speaker: 0 } })).toBe("speaker_0");
    expect(normalizeVolcengineFileSpeaker({})).toBe("speaker_0");
    expect(normalizeVolcengineFileSpeaker({ additions: { speaker: "unknown" } })).toBe("speaker_0");
  });
});

function createFixture() {
  const tempDir = mkdtempSync(join(tmpdir(), "volcengine-file-"));
  tempDirs.push(tempDir);
  const storagePaths = {
    dataDir: tempDir,
    databasePath: join(tempDir, "test.db"),
    discussionsDir: join(tempDir, "discussions")
  };
  const repository = new DiscussionRepository(openDatabase(storagePaths.databasePath));
  const discussion = repository.createDiscussion({
    title: "文件转写测试",
    topic: "文件转写测试",
    background: "文件转写测试",
    projectPath: tempDir,
    participants: [{ displayName: "甲" }, { displayName: "乙" }],
    mode: "real",
    asrProvider: "volcengine-file"
  }, "thread-test");
  return { repository, storagePaths, discussionId: discussion.id };
}
