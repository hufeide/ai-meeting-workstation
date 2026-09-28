import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CustomerDetailDto, CustomerSummaryDto, DiscussionDetailDto, MemoryDraftDto, RollingMemoryDto } from "../../shared/types";
import type { CustomerProfileRequest } from "../../shared/schemas";
import type { StoragePaths } from "../storage/paths";

export class MemoryStore {
  readonly customersDir: string;

  constructor(storagePaths: StoragePaths) {
    this.customersDir = join(storagePaths.dataDir, "customers");
    mkdirSync(this.customersDir, { recursive: true });
  }

  listCustomers(): CustomerSummaryDto[] {
    if (!existsSync(this.customersDir)) return [];
    return readdirSync(this.customersDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry): CustomerSummaryDto | undefined => {
        try {
          const detail = this.getCustomer(entry.name);
          return {
            id: detail.id,
            displayName: detail.displayName,
            memoryCount: detail.memoryCount,
            updatedAt: detail.updatedAt
          };
        } catch {
          return undefined;
        }
      })
      .filter((item): item is CustomerSummaryDto => item !== undefined);
  }

  getCustomer(customerId: string, recentCount?: number): CustomerDetailDto {
    const id = requireCustomerId(customerId);
    const root = this.customerDir(id);
    const meta = readJson<{ id: string; displayName: string; recentCount: number; updatedAt?: string }>(join(root, "company-profile.json"), {
      id,
      displayName: id,
      recentCount: recentCount ?? 5
    });
    const memories = this.listMemories(id);
    const count = clampRecentCount(recentCount ?? meta.recentCount ?? 5);
    return {
      id,
      displayName: meta.displayName || id,
      memoryCount: memories.length,
      updatedAt: meta.updatedAt,
      profile: readText(join(root, "company-profile.md"), defaultProfile(id)),
      recentCount: count,
      recentMemories: memories.slice(-count),
      speakerMap: readJson<Record<string, string>>(join(root, "speaker-map.json"), {}),
      paths: {
        profile: join(root, "company-profile.md"),
        rollingMemory: join(root, "rolling-memory.json"),
        draftsDir: join(root, "pending-memory-drafts")
      }
    };
  }

  saveCustomer(input: CustomerProfileRequest): CustomerDetailDto {
    const id = requireCustomerId(input.id);
    const root = this.customerDir(id);
    mkdirSync(root, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(root, "company-profile.md"), `${input.profile.trim()}\n`, "utf8");
    writeJson(join(root, "company-profile.json"), {
      id,
      displayName: input.displayName.trim() || id,
      recentCount: clampRecentCount(input.recentCount),
      updatedAt: now
    });
    if (!existsSync(join(root, "rolling-memory.json"))) writeJson(join(root, "rolling-memory.json"), []);
    if (!existsSync(join(root, "rolling-memory.md"))) writeFileSync(join(root, "rolling-memory.md"), "# 滚动记忆\n\n", "utf8");
    if (!existsSync(join(root, "speaker-map.json"))) writeJson(join(root, "speaker-map.json"), {});
    return this.getCustomer(id);
  }

  rememberSpeaker(customerId: string, speakerLabel: string, displayName: string): void {
    const id = requireCustomerId(customerId);
    const root = this.customerDir(id);
    mkdirSync(root, { recursive: true });
    const path = join(root, "speaker-map.json");
    const speakerMap = readJson<Record<string, string>>(path, {});
    speakerMap[speakerLabel] = displayName;
    writeJson(path, speakerMap);
  }

  buildPromptContext(customerId: string | undefined, recentCount: number): string {
    if (!customerId) return "";
    const customer = this.getCustomer(customerId, recentCount);
    const memoryText = customer.recentMemories
      .map((item) => `### ${item.createdAt} / ${item.sourceDiscussionId}\n${item.content}`)
      .join("\n\n")
      .trim();
    const speakerMapText = Object.entries(customer.speakerMap)
      .map(([label, name]) => `${label} = ${name}`)
      .join("\n");

    return [
      "以下是稳定客户背景。请优先作为上下文，不要把它当作本次新增发言；这一段保持在提示词前部，便于云端模型提示词缓存降本。",
      "",
      "【公司档案】",
      customer.profile || "暂无",
      "",
      `【最近 ${customer.recentMemories.length} 条滚动记忆】`,
      memoryText || "暂无",
      "",
      "【说话人映射】",
      speakerMapText || "暂无"
    ].join("\n");
  }

  createDraft(input: { customerId: string; discussionId: string; content: string }): MemoryDraftDto {
    const customerId = requireCustomerId(input.customerId);
    const now = new Date().toISOString();
    const draft: MemoryDraftDto = {
      id: randomUUID(),
      customerId,
      discussionId: input.discussionId,
      content: input.content.trim(),
      status: "draft",
      createdAt: now,
      updatedAt: now
    };
    const path = this.draftPath(customerId, input.discussionId);
    mkdirSync(join(this.customerDir(customerId), "pending-memory-drafts"), { recursive: true });
    writeJson(path, draft);
    writeFileSync(path.replace(/\.json$/, ".md"), `# 记忆草稿\n\n${draft.content}\n`, "utf8");
    return draft;
  }

  getDraft(customerId: string, discussionId: string): MemoryDraftDto | null {
    const path = this.draftPath(customerId, discussionId);
    return existsSync(path) ? readJson<MemoryDraftDto>(path, null as unknown as MemoryDraftDto) : null;
  }

  confirmDraft(input: { customerId: string; discussionId: string; content: string }): RollingMemoryDto {
    const customerId = requireCustomerId(input.customerId);
    const now = new Date().toISOString();
    const memory: RollingMemoryDto = {
      id: randomUUID(),
      customerId,
      sourceDiscussionId: input.discussionId,
      content: input.content.trim(),
      createdAt: now
    };
    const memories = this.listMemories(customerId);
    memories.push(memory);
    const root = this.customerDir(customerId);
    mkdirSync(root, { recursive: true });
    writeJson(join(root, "rolling-memory.json"), memories);
    writeFileSync(
      join(root, "rolling-memory.md"),
      ["# 滚动记忆", "", ...memories.map((item) => `## ${item.createdAt} / ${item.sourceDiscussionId}\n${item.content}`), ""].join("\n\n"),
      "utf8"
    );
    const draft = this.getDraft(customerId, input.discussionId);
    if (draft) {
      writeJson(this.draftPath(customerId, input.discussionId), {
        ...draft,
        content: input.content.trim(),
        status: "confirmed",
        updatedAt: now
      });
    }
    return memory;
  }

  buildMemoryDraftPrompt(discussion: DiscussionDetailDto): string {
    const transcript = discussion.utterances
      .filter((utterance) => utterance.isFinal)
      .map((utterance) => {
        const participant = discussion.participants.find((item) => item.id === utterance.participantId);
        return `${participant?.displayName ?? utterance.speakerLabel}: ${utterance.text}`;
      })
      .join("\n");
    const customerContext = this.buildPromptContext(discussion.customerId, 5);

    return [
      customerContext,
      "请从下面这次会议转写中起草一条“滚动记忆”，必须便于下次会议前喂给模型。",
      "只提炼：决策、待办、结论、说话人身份、行业术语、未决事项。不要把不确定内容写成事实。",
      "输出为中文项目符号，保持简洁。",
      "",
      "【本次会议转写】",
      transcript || "暂无转写。"
    ]
      .filter(Boolean)
      .join("\n");
  }

  private listMemories(customerId: string): RollingMemoryDto[] {
    return readJson<RollingMemoryDto[]>(join(this.customerDir(customerId), "rolling-memory.json"), []);
  }

  private draftPath(customerId: string, discussionId: string): string {
    const safeDiscussion = discussionId.replace(/[^0-9A-Za-z_.-]+/g, "-").slice(0, 96);
    return join(this.customerDir(customerId), "pending-memory-drafts", `${safeDiscussion}.json`);
  }

  private customerDir(customerId: string): string {
    const root = resolve(this.customersDir);
    const target = resolve(join(root, requireCustomerId(customerId)));
    if (!target.startsWith(root)) throw new Error("客户路径非法。");
    return target;
  }
}

function requireCustomerId(customerId: string): string {
  const clean = customerId.trim();
  if (!/^[0-9A-Za-z\u4e00-\u9fa5_.-]{1,64}$/.test(clean)) {
    throw new Error("客户 ID 只能包含中英文、数字、点、下划线和短横线。");
  }
  return clean;
}

function defaultProfile(customerId: string): string {
  return [
    `# ${customerId} 公司档案`,
    "",
    "## 公司做什么",
    "待填写",
    "",
    "## 合伙人及分工",
    "待填写",
    "",
    "## 行业术语",
    "待填写",
    "",
    "## 长期目标",
    "待填写",
    ""
  ].join("\n");
}

function clampRecentCount(value: number): number {
  return Math.max(1, Math.min(Number.isFinite(value) ? Math.floor(value) : 5, 20));
}

function readText(path: string, fallback: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : fallback;
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
