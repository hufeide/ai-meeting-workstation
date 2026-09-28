import { describe, expect, it } from "vitest";
import { mapVolcengineError, normalizeSpeakerLabel, VolcengineAsrProvider } from "./volcengineAsr";

describe("VolcengineAsrProvider", () => {
  it("returns a clear credential error when required env values are missing", () => {
    const provider = new VolcengineAsrProvider({
      endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
    });

    expect(provider.checkCredentials()).toEqual({
      ok: false,
      message:
        "缺少火山 ASR 凭证：VOLCENGINE_ASR_API_KEY, VOLCENGINE_ASR_RESOURCE_ID。请在 .env 中配置后再启用真实 ASR。"
    });
  });

  it("builds new console websocket handshake headers", () => {
    const provider = new VolcengineAsrProvider({
      apiKey: "api-key",
      resourceId: "volc.seedasr.sauc.duration",
      endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
    });

    expect(provider.createHandshakeHeaders("connect-id")).toEqual({
      "X-Api-Key": "api-key",
      "X-Api-Resource-Id": "volc.seedasr.sauc.duration",
      "X-Api-Connect-Id": "connect-id"
    });
  });

  it("maps vendor error codes to readable Chinese messages", () => {
    expect(mapVolcengineError(401, "invalid api key")).toBe("火山 ASR 鉴权失败，请检查 API Key 和 Resource ID（invalid api key）");
    expect(mapVolcengineError(429)).toBe("火山 ASR 调用频率或额度受限，请稍后重试");
    expect(mapVolcengineError(500, "upstream unavailable")).toBe("火山 ASR 服务异常，请稍后重试（upstream unavailable）");
  });

  it("normalizes speaker fields with stable fallback", () => {
    expect(normalizeSpeakerLabel({ text: "一", speaker_id: "speaker_2" })).toBe("speaker_2");
    expect(normalizeSpeakerLabel({ text: "二", additions: JSON.stringify({ speaker_info: { speaker_id: 3 } }) })).toBe("speaker_3");
    expect(normalizeSpeakerLabel({ text: "三" })).toBe("speaker_0");
  });
});
