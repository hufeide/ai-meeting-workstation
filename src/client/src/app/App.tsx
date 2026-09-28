import { useEffect, useMemo, useRef, useState } from "react";
import { isUsableAiTurn, isUsableAiTurnStatus } from "../../../shared/aiTurns";
import type { AsrStatus, ProductEvent } from "../../../shared/events";
import type {
  AsrProviderType,
  BrainProviderType,
  CustomerDetailDto,
  CustomerSummaryDto,
  DemoBootstrapDto,
  DiscussionDetailDto,
  DiscussionSummaryDto,
  MemoryDraftDto,
  ParticipantDto,
  PublicAppSettingsDto,
  UtteranceDto,
  WorkspaceDataScope
} from "../../../shared/types";
import {
  bindSpeaker,
  bootstrapDemoMode,
  confirmMemory,
  createDiscussion,
  deleteDiscussion,
  deleteDiscussionAudio,
  draftMemory,
  discussionMarkdownExportUrl,
  discussionPackageExportUrl,
  endDiscussion,
  getAppConfig,
  getCustomer,
  getDiscussion,
  listDiscussions,
  listCustomers,
  loadDemoFallbackAudio,
  markAiTurnFeedback,
  resetDemoMode,
  saveCustomer,
  saveSettings,
  triggerAiTurn,
  uploadAudioFile
} from "./api";
import { codexResumeCommand } from "./codexCommand";
import { buildVisibleDiscussionTimeline, mergeAiTurn, mergeUtterance, unboundSpeakerLabels, type TimelineItem } from "./discussionTimeline";
import { aiTurnDisplayText, aiTurnSystemNotice, mainErrorText } from "./errorPresentation";
import { SingleFlight } from "./singleFlight";
import { VoiceInvitationDetector } from "./voiceInvitation";
import { formatFileSize, isFileAsrProvider, parseKnownSpeakers, taskModeForDiscussion, transcriptionNameFromFile, type TaskMode } from "./taskMode";
import {
  addParticipant,
  createDefaultParticipants,
  removeParticipant,
  updateParticipant,
  type ParticipantFormItem
} from "./participantForm";

type FormState = {
  background: string;
  customerId: string;
  customerName: string;
  customerProfile: string;
  participants: ParticipantFormItem[];
  projectPath: string;
  asrProvider: AsrProviderType;
  brainProvider: BrainProviderType;
  brainModel: string;
};

type AsrDiagnostics = {
  micAuthorized: boolean;
  audioSending: boolean;
  asrConnected: boolean;
  asrReceiving: boolean;
  errorMessage?: string;
  retryable: boolean;
};

type SessionPhase = "ready" | "listening" | "capturing" | "agent-thinking" | "agent-joined" | "handoff-ready" | "handoff-copied";

const initialFormState: FormState = {
  background: "",
  customerId: "",
  customerName: "",
  customerProfile: defaultCustomerProfile(""),
  participants: createDefaultParticipants(),
  projectPath: ".",
  asrProvider: "volcengine",
  brainProvider: "deepseek",
  brainModel: "deepseek-v4-pro"
};

const initialAsrDiagnostics: AsrDiagnostics = {
  micAuthorized: false,
  audioSending: false,
  asrConnected: false,
  asrReceiving: false,
  retryable: false
};

export function App() {
  const [form, setForm] = useState<FormState>(initialFormState);
  const [workspaceScope, setWorkspaceScope] = useState<WorkspaceDataScope>("normal");
  const [demoBootstrap, setDemoBootstrap] = useState<DemoBootstrapDto | null>(null);
  const [isDemoModeLoading, setIsDemoModeLoading] = useState(false);
  const [isFallbackLoading, setIsFallbackLoading] = useState(false);
  const [fallbackLoaded, setFallbackLoaded] = useState(false);
  const [discussion, setDiscussion] = useState<DiscussionDetailDto | null>(null);
  const [asrStatus, setAsrStatus] = useState<AsrStatus>("idle");
  const [isStarting, setIsStarting] = useState(false);
  const [isInvitingCodex, setIsInvitingCodex] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isAudioStarting, setIsAudioStarting] = useState(false);
  const [isAudioFileUploading, setIsAudioFileUploading] = useState(false);
  const [taskMode, setTaskMode] = useState<TaskMode>("home");
  const [selectedAudioFile, setSelectedAudioFile] = useState<File | null>(null);
  const [fileTranscriptionName, setFileTranscriptionName] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [asrDiagnostics, setAsrDiagnostics] = useState<AsrDiagnostics>(initialAsrDiagnostics);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isKnowledgeOpen, setIsKnowledgeOpen] = useState(false);
  const [isCommandExpanded, setIsCommandExpanded] = useState(false);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const [isGuidanceOpen, setIsGuidanceOpen] = useState(false);
  const [aiGuidance, setAiGuidance] = useState("");
  const [recentDiscussions, setRecentDiscussions] = useState<DiscussionSummaryDto[]>([]);
  const [appSettings, setAppSettings] = useState<PublicAppSettingsDto | null>(null);
  const [customers, setCustomers] = useState<CustomerSummaryDto[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerDetailDto | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<MemoryDraftDto | null>(null);
  const [memoryDraftText, setMemoryDraftText] = useState("");
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const hasSentAudioRef = useRef(false);
  const primaryFunasrInputRef = useRef<HTMLInputElement | null>(null);
  const audioUploadFlightRef = useRef(new SingleFlight());
  const audioSessionRef = useRef<{
    context: AudioContext;
    processor: ScriptProcessorNode;
    source: MediaStreamAudioSourceNode;
    stream: MediaStream;
    socket: WebSocket;
  } | null>(null);
  const conversationFeedRef = useRef<HTMLDivElement | null>(null);
  const aiTurnFlightRef = useRef(false);
  const voiceInvitationRef = useRef<VoiceInvitationDetector | null>(null);
  const liveMeetingRef = useRef({
    discussionId: discussion?.id,
    isRecording,
    isActive: discussion?.status === "active",
    isLiveAsr: discussion?.asrProvider === "volcengine"
  });
  const inviteByVoiceRef = useRef<(guidance: string) => void>(() => undefined);
  liveMeetingRef.current = {
    discussionId: discussion?.id,
    isRecording,
    isActive: discussion?.status === "active",
    isLiveAsr: discussion?.asrProvider === "volcengine"
  };
  inviteByVoiceRef.current = (guidance) => { void inviteAi(guidance, "voice"); };
  if (!voiceInvitationRef.current) {
    voiceInvitationRef.current = new VoiceInvitationDetector(
      (guidance) => inviteByVoiceRef.current(guidance),
      () => {
        const meeting = liveMeetingRef.current;
        return meeting.isRecording && meeting.isActive && meeting.isLiveAsr;
      }
    );
  }

  useEffect(() => {
    void getAppConfig()
      .then((config) => {
        setAppSettings(config.settings);
        setForm((current) => ({
          ...current,
          projectPath: config.defaultProjectPath,
          asrProvider: config.settings.asrProvider,
          brainProvider: config.settings.brainProvider,
          brainModel: config.settings.brainModel
        }));
      })
      .catch(() => {
        setErrorMessage("读取本地配置失败，请确认后端服务正在运行。");
      });
  }, []);

  useEffect(() => {
    void loadRecentDiscussions("normal");
    void loadCustomers("normal");
  }, []);

  useEffect(() => {
    if (!discussion || isFileAsrProvider(discussion.asrProvider)) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws?discussionId=${discussion.id}`);

    socket.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as ProductEvent;
      if (event.type === "asr.status") {
        setAsrStatus(event.status);
        if (event.status === "connected") {
          setAsrDiagnostics((current) => ({ ...current, asrConnected: true }));
        }
        if (event.status === "receiving") {
          setAsrDiagnostics((current) => ({ ...current, asrConnected: true, asrReceiving: true }));
        }
      }
      if (event.type === "asr.error") {
        setAsrStatus("failed");
        setErrorMessage(event.message);
        setIsDiagnosticsOpen(true);
        setAsrDiagnostics((current) => ({
          ...current,
          errorMessage: event.message,
          retryable: event.retryable
        }));
      }
      if (event.type === "transcript.partial" || event.type === "transcript.final") {
        setAsrDiagnostics((current) => ({ ...current, asrReceiving: true }));
        setDiscussion((current) => mergeUtterance(current, event.utterance));
        if (event.utterance.source === "volcengine" && liveMeetingRef.current.discussionId === discussion.id) {
          if (event.type === "transcript.partial") voiceInvitationRef.current?.onPartial();
          else voiceInvitationRef.current?.onFinal(event.utterance);
        }
      }
      if (event.type === "audio.asset.saved") {
        void refreshDiscussion(discussion.id);
      }
      if (event.type === "speaker.binding.updated") {
        void refreshDiscussion(discussion.id);
      }
      if (event.type === "codex.turn.completed" || event.type === "codex.turn.truncated") {
        setDiscussion((current) => mergeAiTurn(current, event.aiTurn));
      }
      if (event.type === "codex.turn.failed") {
        setErrorMessage(event.message);
        void refreshDiscussion(discussion.id);
      }
      if (event.type === "discussion.updated") {
        void refreshDiscussion(discussion.id);
      }
    };

    socket.onerror = () => {
      setErrorMessage("WebSocket 连接失败，请确认后端服务正在运行。");
    };

    return () => {
      socket.close();
      voiceInvitationRef.current?.reset();
    };
  }, [discussion?.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsSettingsOpen(false);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsSettingsOpen((current) => !current);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && discussion && discussion.status === "active") {
        event.preventDefault();
        void handleInviteCodex();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const isEnded = discussion?.status === "ended";
  const isDemoMode = workspaceScope === "demo";
  const visibleTimeline = useMemo(() => (discussion ? buildVisibleDiscussionTimeline(discussion, { isInvitingCodex }) : []), [discussion, isInvitingCodex]);
  const speakerLabels = useMemo(() => (discussion ? unboundSpeakerLabels(discussion) : []), [discussion]);
  const finalUtteranceCount = discussion?.utterances.filter((utterance) => utterance.isFinal).length ?? 0;
  const activeRecentDiscussion = recentDiscussions.find((item) => item.status === "active");
  const finalUtteranceCountForNextAi = useMemo(() => (discussion ? countFinalUtterancesSinceLastAiTurn(discussion) : 0), [discussion]);
  const resumeCommand = discussion?.codexThreadId
    ? codexResumeCommand({ codexThreadId: discussion.codexThreadId, projectPath: discussion.projectPath })
    : "";
  const phase = sessionPhase({
    discussion,
    isRecording,
    isInvitingCodex,
    finalUtteranceCount,
    copyStatus
  });
  const conversationItems = visibleTimeline;
  const conversationFollowKey = conversationItems
    .map((item) => {
      if (item.type === "utterance") return `${item.id}:${item.utterance.text}:${item.utterance.isFinal}`;
      if (item.type === "aiTurn") return `${item.id}:${item.aiTurn.response ?? ""}`;
      return item.id;
    })
    .join("|");
  const latestUsableAiTurn = discussion?.aiTurns.filter(isUsableAiTurn).slice(-1)[0] ?? null;
  const settingsHasAlert = Boolean(errorMessage || speakerLabels.length > 0 || asrStatus === "failed");
  const isFileMode = taskMode === "file";
  const isFileResult = Boolean(isFileMode && discussion && finalUtteranceCount > 0);
  const isTaskBusy = isAudioFileUploading || isFallbackLoading || isStarting || isAudioStarting || isRecording;

  useEffect(() => {
    setIsFollowingLatest(true);
  }, [discussion?.id]);

  useEffect(() => {
    if (!isFollowingLatest) return;
    const animationFrame = window.requestAnimationFrame(() => {
      const feed = conversationFeedRef.current;
      if (!feed) return;
      feed.scrollTo({
        top: feed.scrollHeight,
        behavior: isRecording ? "smooth" : "auto"
      });
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [conversationFollowKey, isFollowingLatest, isRecording]);

  async function refreshDiscussion(discussionId: string) {
    const nextDiscussion = await getDiscussion(discussionId, workspaceScope);
    setDiscussion(nextDiscussion);
  }

  async function loadRecentDiscussions(scope: WorkspaceDataScope = workspaceScope) {
    try {
      const discussions = await listDiscussions(scope);
      setRecentDiscussions(discussions);
    } catch {
      setRecentDiscussions([]);
    }
  }

  async function loadCustomers(scope: WorkspaceDataScope = workspaceScope) {
    try {
      const nextCustomers = await listCustomers(scope);
      setCustomers(nextCustomers);
    } catch {
      setCustomers([]);
    }
  }

  async function handleSelectCustomer(customerId: string) {
    if (!customerId) {
      setSelectedCustomer(null);
      setForm((current) => ({
        ...current,
        customerId: "",
        customerName: "",
        customerProfile: defaultCustomerProfile("")
      }));
      return;
    }
    const customer = await getCustomer(customerId, workspaceScope);
    setSelectedCustomer(customer);
    setForm((current) => ({
      ...current,
      customerId: customer.id,
      customerName: customer.displayName,
      customerProfile: customer.profile
    }));
  }

  async function handleSaveCustomer() {
    const id = form.customerId.trim();
    if (!id) {
      setErrorMessage("请先填写客户 ID。");
      return;
    }
    const customer = await saveCustomer({
      id,
      displayName: form.customerName.trim() || id,
      profile: form.customerProfile.trim() || defaultCustomerProfile(id),
      recentCount: appSettings?.recentMemoryCount ?? 5
    }, workspaceScope);
    setSelectedCustomer(customer);
    setLocalStatus("客户档案已保存，本地存储，不会自动上云。");
    await loadCustomers(workspaceScope);
  }

  async function handleSaveSettings(update: Partial<PublicAppSettingsDto> & {
    deepseekApiKey?: string;
    openaiApiKey?: string;
    volcengineApiKey?: string;
  }) {
    const next = await saveSettings(update);
    setAppSettings(next);
    setForm((current) => ({
      ...current,
      asrProvider: next.asrProvider,
      brainProvider: next.brainProvider,
      brainModel: next.brainModel
    }));
    setLocalStatus("设置已保存到本机。");
  }

  function applyDemoBootstrap(bootstrap: DemoBootstrapDto) {
    setDemoBootstrap(bootstrap);
    setSelectedCustomer(bootstrap.customer);
    setForm((current) => ({
      ...current,
      background: bootstrap.meeting.background,
      customerId: bootstrap.customer.id,
      customerName: bootstrap.customer.displayName,
      customerProfile: bootstrap.customer.profile,
      participants: bootstrap.meeting.participants.map((participant, index) => ({
        id: `demo-participant-${index + 1}`,
        displayName: participant.displayName
      }))
    }));
    setFallbackLoaded(false);
    setMemoryDraft(null);
    setMemoryDraftText("");
  }

  async function handleEnterDemoMode() {
    setIsDemoModeLoading(true);
    setErrorMessage(null);
    try {
      await stopAudioCapture();
      const bootstrap = await bootstrapDemoMode();
      setWorkspaceScope("demo");
      setDiscussion(null);
      applyDemoBootstrap(bootstrap);
      setCustomers(await listCustomers("demo"));
      setRecentDiscussions(await listDiscussions("demo"));
      setIsSettingsOpen(false);
      setLocalStatus("演示模式已载入：公司档案、参会人和会议背景均为虚构数据。");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "演示模式载入失败。");
    } finally {
      setIsDemoModeLoading(false);
    }
  }

  async function handleExitDemoMode() {
    if (isFallbackLoading) return;
    await stopAudioCapture();
    setWorkspaceScope("normal");
    setDiscussion(null);
    setDemoBootstrap(null);
    setSelectedCustomer(null);
    setFallbackLoaded(false);
    setMemoryDraft(null);
    setMemoryDraftText("");
    setAsrStatus("idle");
    setAsrDiagnostics(initialAsrDiagnostics);
    setErrorMessage(null);
    setLocalStatus(null);
    setForm((current) => ({
      ...initialFormState,
      projectPath: current.projectPath,
      asrProvider: appSettings?.asrProvider ?? current.asrProvider,
      brainProvider: appSettings?.brainProvider ?? current.brainProvider,
      brainModel: appSettings?.brainModel ?? current.brainModel
    }));
    setCustomers(await listCustomers("normal"));
    setRecentDiscussions(await listDiscussions("normal"));
  }

  async function handleResetDemoMode() {
    if (!isDemoMode || isFallbackLoading) return;
    setIsDemoModeLoading(true);
    setErrorMessage(null);
    try {
      await stopAudioCapture();
      const bootstrap = await resetDemoMode();
      setDiscussion(null);
      applyDemoBootstrap(bootstrap);
      setCustomers(await listCustomers("demo"));
      setRecentDiscussions([]);
      setAsrStatus("idle");
      setAsrDiagnostics(initialAsrDiagnostics);
      setIsSettingsOpen(false);
      setLocalStatus("演示空间已重置，只保留澄远科技的干净初始档案。");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "演示空间重置失败。");
    } finally {
      setIsDemoModeLoading(false);
    }
  }

  async function handleOpenDiscussion(discussionId: string) {
    await stopAudioCapture();
    const nextDiscussion = await getDiscussion(discussionId, workspaceScope);
    setTaskMode(taskModeForDiscussion(nextDiscussion));
    setDiscussion(nextDiscussion);
    setAsrStatus("idle");
    setAsrDiagnostics(initialAsrDiagnostics);
    setIsDiagnosticsOpen(false);
    setIsSettingsOpen(false);
    setCopyStatus(null);
    setAiGuidance("");
    setIsGuidanceOpen(false);
    setFallbackLoaded(false);
  }

  async function handleReturnHome() {
    await stopAudioCapture();
    setDiscussion(null);
    setAsrStatus("idle");
    setAsrDiagnostics(initialAsrDiagnostics);
    setIsDiagnosticsOpen(false);
    setCopyStatus(null);
    setErrorMessage(null);
    setAiGuidance("");
    setIsGuidanceOpen(false);
    setFallbackLoaded(false);
    setTaskMode("home");
    setSelectedAudioFile(null);
    setFileTranscriptionName("");
    void loadRecentDiscussions(workspaceScope);
  }

  async function handleNewDiscussion() {
    await handleReturnHome();
    setForm((current) => ({
      ...current,
      background: isDemoMode ? demoBootstrap?.meeting.background ?? current.background : ""
    }));
  }

  function handleSelectTask(nextMode: Exclude<TaskMode, "home">) {
    if (isTaskBusy) return;
    setTaskMode(nextMode);
    setDiscussion(null);
    setErrorMessage(null);
    setLocalStatus(null);
    if (nextMode === "file") {
      setForm((current) => ({ ...current, asrProvider: isFileAsrProvider(current.asrProvider) ? current.asrProvider : "volcengine-file" }));
    } else {
      setSelectedAudioFile(null);
      setFileTranscriptionName("");
      setForm((current) => ({ ...current, asrProvider: current.asrProvider === "volcengine" || current.asrProvider === "mock" ? current.asrProvider : "volcengine" }));
    }
  }

  function handleChooseAudioFile(file: File) {
    if (isAudioFileUploading) return;
    setSelectedAudioFile(file);
    setFileTranscriptionName((current) => current || transcriptionNameFromFile(file.name));
    setErrorMessage(null);
    setLocalStatus("文件已选择，尚未上传。确认方式后点击“开始转写”。");
  }

  function handleClearAudioFile() {
    if (isAudioFileUploading) return;
    setSelectedAudioFile(null);
    setFileTranscriptionName("");
    setErrorMessage(null);
    setLocalStatus(null);
  }

  async function handleStart() {
    setIsStarting(true);
    setErrorMessage(null);
    try {
      const nextDiscussion = await createDiscussion({
        background: form.background,
        customerId: form.customerId.trim() || undefined,
        projectPath: form.projectPath,
        participants: form.participants.map((participant) => ({
          displayName: participant.displayName
        })),
        asrProvider: form.asrProvider,
        brainProvider: form.brainProvider,
        brainModel: form.brainModel,
        mode: form.asrProvider === "mock" ? "mock" : "real"
      }, workspaceScope);
      setDiscussion(nextDiscussion);
      setAsrDiagnostics(initialAsrDiagnostics);
      setIsDiagnosticsOpen(false);
      setIsSettingsOpen(false);
      void loadRecentDiscussions(workspaceScope);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "创建讨论失败");
    } finally {
      setIsStarting(false);
    }
  }

  async function handleStartFileTranscription() {
    if (!selectedAudioFile || audioUploadFlightRef.current.isActive) return;
    const file = selectedAudioFile;
    const provider = isFileAsrProvider(form.asrProvider) ? form.asrProvider : "volcengine-file";
    await audioUploadFlightRef.current.run(async () => {
      setIsAudioFileUploading(true);
      setErrorMessage(null);
      setLocalStatus("正在上传并识别，请勿重复操作");
      try {
        const activeDiscussion = discussion && isFileAsrProvider(discussion.asrProvider)
          ? discussion
          : await createDiscussion({
              background: [fileTranscriptionName.trim() || transcriptionNameFromFile(file.name), form.background.trim()].filter(Boolean).join("\n\n"),
              projectPath: form.projectPath,
              participants: form.participants.map((participant) => ({ displayName: participant.displayName })),
              asrProvider: provider,
              brainProvider: form.brainProvider,
              brainModel: form.brainModel,
              mode: "real"
            }, workspaceScope);
        setDiscussion(activeDiscussion);
        const result = await uploadAudioFile({ discussionId: activeDiscussion.id, file }, workspaceScope);
        setDiscussion(result.discussion);
        setLocalStatus(`转写完成：已写入 ${result.utteranceCount} 条转写片段。`);
        void loadRecentDiscussions(workspaceScope);
      } catch (error) {
        setLocalStatus("转写失败，可保留当前文件直接重试。");
        setErrorMessage(error instanceof Error ? error.message : "录音文件识别失败。");
      } finally {
        setIsAudioFileUploading(false);
      }
    });
  }

  async function handleBindSpeaker(speakerLabel: string, participant: ParticipantDto) {
    if (!discussion) return;
    await bindSpeaker({
      discussionId: discussion.id,
      speakerLabel,
      participantId: participant.id
    }, workspaceScope);
    await refreshDiscussion(discussion.id);
  }

  async function handleInviteCodex() {
    voiceInvitationRef.current?.cancelPending();
    await inviteAi(aiGuidance, "manual");
  }

  async function inviteAi(guidance: string | undefined, source: "manual" | "voice") {
    if (!discussion) return;
    if (source === "voice" && (!isRecording || discussion.status !== "active" || discussion.asrProvider !== "volcengine")) return;
    if (aiTurnFlightRef.current) return;
    aiTurnFlightRef.current = true;
    const activeDiscussionId = discussion.id;
    setIsInvitingCodex(true);
    setErrorMessage(null);
    try {
      const aiTurn = await triggerAiTurn(activeDiscussionId, guidance, workspaceScope);
      setDiscussion((current) => current?.id === activeDiscussionId ? mergeAiTurn(current, aiTurn) : current);
      if (source === "manual") {
        setAiGuidance("");
        setIsGuidanceOpen(false);
      }
    } catch (error) {
      if (liveMeetingRef.current.discussionId === activeDiscussionId) {
        setErrorMessage(error instanceof Error ? error.message : "邀请 AI 失败");
      }
    } finally {
      aiTurnFlightRef.current = false;
      setIsInvitingCodex(false);
    }
  }

  async function handleUploadAudio(file: File) {
    if (!discussion || audioUploadFlightRef.current.isActive) return;
    const activeDiscussion = discussion;
    const activeScope = workspaceScope;
    const isVolcengineFile = activeDiscussion.asrProvider === "volcengine-file";
    await audioUploadFlightRef.current.run(async () => {
      setIsAudioFileUploading(true);
      setErrorMessage(null);
      setLocalStatus(
        isVolcengineFile
          ? "正在上传并等待火山识别，请勿重复操作。"
          : "正在用本地 FunASR 识别上传录音，请勿重复操作。"
      );
      try {
        const result = await uploadAudioFile({ discussionId: activeDiscussion.id, file }, activeScope);
        setDiscussion(result.discussion);
        setLocalStatus(`${isVolcengineFile ? "火山录音文件识别" : "FunASR"}已写入 ${result.utteranceCount} 条转写片段。`);
      } catch (error) {
        setLocalStatus(null);
        setErrorMessage(error instanceof Error ? error.message : "录音文件识别失败。");
      } finally {
        setIsAudioFileUploading(false);
      }
    });
  }

  async function handleLoadFallbackAudio() {
    if (!discussion || !isDemoMode) return;
    setIsFallbackLoading(true);
    setErrorMessage(null);
    setLocalStatus("正在用本地 FunASR 处理预置兜底录音...");
    try {
      await stopAudioCapture();
      const result = await loadDemoFallbackAudio(discussion.id);
      setDiscussion(result.discussion);
      setFallbackLoaded(true);
      setAsrStatus("idle");
      setLocalStatus(
        result.alreadyLoaded
          ? "这条演示会议已经载入过兜底录音，没有重复写入。"
          : `兜底录音已完成真实本地转写，写入 ${result.utteranceCount} 条片段。`
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "兜底录音处理失败。");
      setLocalStatus(null);
    } finally {
      setIsFallbackLoading(false);
    }
  }

  async function handleDraftMemory() {
    if (!discussion) return;
    setLocalStatus("正在让当前大脑起草本次会议记忆...");
    const draft = await draftMemory(discussion.id, workspaceScope);
    setMemoryDraft(draft);
    setMemoryDraftText(draft.content);
    setLocalStatus("记忆草稿已生成，确认或修改后才会入库。");
  }

  async function handleConfirmMemory(content: string) {
    if (!discussion) return;
    const result = await confirmMemory({ discussionId: discussion.id, content }, workspaceScope);
    setSelectedCustomer(result.customer);
    setMemoryDraft(null);
    setMemoryDraftText("");
    setLocalStatus("滚动记忆已确认入库。");
    await loadCustomers(workspaceScope);
  }

  async function handleMarkAiFeedback(aiTurnId: string, rating: "useful" | "bad") {
    if (!discussion) return;
    const aiTurn = await markAiTurnFeedback({ discussionId: discussion.id, aiTurnId, rating }, workspaceScope);
    setDiscussion((current) =>
      current
        ? {
            ...current,
            aiTurns: current.aiTurns.map((item) => (item.id === aiTurn.id ? aiTurn : item))
          }
        : current
    );
  }

  async function handleEndDiscussion() {
    if (!discussion) return;
    await stopAudioCapture();
    const ended = await endDiscussion(discussion.id, workspaceScope);
    setDiscussion(ended);
    setAsrStatus("idle");
    setIsCommandExpanded(true);
    void loadRecentDiscussions(workspaceScope);
  }

  async function handleDeleteDiscussion() {
    if (!discussion) return;
    if (!window.confirm("确认删除这条讨论及其本地音频文件吗？此操作不可撤销。")) return;
    await stopAudioCapture();
    await deleteDiscussion(discussion.id, workspaceScope);
    setDiscussion(null);
    setErrorMessage(null);
    setIsSettingsOpen(false);
    void loadRecentDiscussions(workspaceScope);
  }

  async function handleDeleteAudio() {
    if (!discussion) return;
    if (!window.confirm("确认删除本次讨论的本地音频文件吗？转写和 AI 发言会保留。")) return;
    const updated = await deleteDiscussionAudio(discussion.id, workspaceScope);
    setDiscussion(updated);
    void loadRecentDiscussions(workspaceScope);
  }

  async function handleCopyCodexCommand(command: string) {
    if (await copyText(command)) {
      setCopyStatus("已复制");
      setIsCommandExpanded(true);
      return;
    }
    setCopyStatus("复制失败");
  }

  async function handleReconnectAsr() {
    if (!discussion || discussion.status !== "active" || discussion.mode !== "real") return;
    await stopAudioCapture();
    setAsrStatus("idle");
    setAsrDiagnostics(initialAsrDiagnostics);
    setErrorMessage(null);
    await startAudioCapture();
    setIsDiagnosticsOpen(true);
  }

  async function toggleAudioCapture() {
    if (isRecording) {
      await stopAudioCapture();
      return;
    }
    await startAudioCapture();
  }

  async function startAudioCapture() {
    if (!discussion) return;
    setIsFollowingLatest(true);
    setErrorMessage(null);
    setIsAudioStarting(true);
    hasSentAudioRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setAsrDiagnostics((current) => ({ ...current, micAuthorized: true, errorMessage: undefined, retryable: false }));
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const audioSocketPath = isDemoMode ? "/demo-audio" : "/audio";
      const socket = new WebSocket(
        `${protocol}//${window.location.host}${audioSocketPath}?discussionId=${discussion.id}&sampleRate=16000`
      );
      socket.binaryType = "arraybuffer";

      processor.onaudioprocess = (event) => {
        const output = event.outputBuffer.getChannelData(0);
        output.fill(0);
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(float32ToPcm16(event.inputBuffer.getChannelData(0), context.sampleRate, 16000));
        if (!hasSentAudioRef.current) {
          hasSentAudioRef.current = true;
          setAsrDiagnostics((current) => ({ ...current, audioSending: true }));
        }
      };

      source.connect(processor);
      processor.connect(context.destination);
      audioSessionRef.current = { context, processor, source, stream, socket };
      setIsRecording(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法启动麦克风。";
      setErrorMessage(message);
      setIsSettingsOpen(true);
      setIsDiagnosticsOpen(true);
      setAsrDiagnostics((current) => ({ ...current, errorMessage: message, retryable: true }));
    } finally {
      setIsAudioStarting(false);
    }
  }

  async function stopAudioCapture() {
    voiceInvitationRef.current?.reset();
    const session = audioSessionRef.current;
    if (!session) return;
    session.processor.disconnect();
    session.source.disconnect();
    session.stream.getTracks().forEach((track) => track.stop());
    session.socket.close();
    await session.context.close();
    audioSessionRef.current = null;
    setIsRecording(false);
  }

  function handleConversationScroll() {
    const feed = conversationFeedRef.current;
    if (!feed) return;
    const distanceFromBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
    setIsFollowingLatest(distanceFromBottom < 72);
  }

  function scrollConversationToLatest() {
    setIsFollowingLatest(true);
    window.requestAnimationFrame(() => {
      conversationFeedRef.current?.scrollTo({
        top: conversationFeedRef.current.scrollHeight,
        behavior: "smooth"
      });
    });
  }

  return (
    <main className={`one-line-workspace phase-${phase}${isDemoMode ? " demo-mode" : ""}`}>
      <header className="workspace-chrome">
        <button type="button" className="brand-signal" disabled={isFallbackLoading} onClick={handleNewDiscussion} aria-label="回到新会议">
          <span className="brand-orbit" aria-hidden="true">
            <span />
            <span />
          </span>
          <span className="brand-copy">
            <strong>AI Meeting Workstation</strong>
            <small>企业会议决策台</small>
          </span>
        </button>
        <div className="workspace-header-actions">
          {isDemoMode ? (
            <>
              <span className="demo-mode-badge">演示模式 · 数据隔离</span>
              <button type="button" className="demo-reset-trigger" disabled={isDemoModeLoading || isFallbackLoading} onClick={() => void handleResetDemoMode()}>
                {isDemoModeLoading ? "重置中" : "重置演示数据"}
              </button>
              <button type="button" className="demo-exit-trigger" disabled={isDemoModeLoading || isFallbackLoading} onClick={() => void handleExitDemoMode()}>
                退出演示
              </button>
            </>
          ) : (
            <button type="button" className="demo-mode-entry" disabled={isDemoModeLoading} onClick={() => void handleEnterDemoMode()}>
              {isDemoModeLoading ? "正在载入" : "进入演示模式"}
            </button>
          )}
          <button type="button" className="knowledge-trigger" onClick={() => setIsKnowledgeOpen(true)}>
            企业知识库 <span>Demo</span>
          </button>
          <button
            type="button"
            className={settingsHasAlert ? "settings-trigger has-alert" : "settings-trigger"}
            onClick={() => setIsSettingsOpen(true)}
            aria-label="打开设置"
          >
            设置 <kbd>⌘ K</kbd>
          </button>
        </div>
      </header>

      {isDemoMode ? (
        <section className="demo-boundary-banner" role="status">
          <strong>当前为演示模式</strong>
          <span>澄远科技及参会人均为虚构数据；会议、录音和记忆只写入独立演示空间。</span>
        </section>
      ) : null}

      {taskMode === "home" ? (
        <section className="task-home" aria-label="选择工作任务">
          <header className="task-home-intro">
            <span>AI MEETING WORKSTATION</span>
            <h1>今天要处理哪一种会议？</h1>
            <p>已有录音直接转写；正在开会则进入实时助手。两条流程各自保持清晰。</p>
          </header>
          <div className="task-entry-grid">
            <article className="task-entry-card file-primary">
              <span className="task-index">01 · FILE TRANSCRIPT</span>
              <h2>上传录音转写</h2>
              <p>已有 M4A、MP3、WAV 等录音，上传后生成完整逐字稿。</p>
              <button type="button" disabled={isTaskBusy} onClick={() => handleSelectTask("file")}>选择录音文件</button>
              <small>默认推荐火山录音文件识别 2.0；也可以选择本地 FunASR。</small>
            </article>
            <article className="task-entry-card live-secondary">
              <span className="task-index">02 · LIVE MEETING</span>
              <h2>实时会议助手</h2>
              <p>现场录音、实时转写，并可在讨论中邀请 AI 参与。</p>
              <button type="button" disabled={isTaskBusy} onClick={() => handleSelectTask("live")}>开始实时会议</button>
              <small>保留会议背景、参与者、麦克风和 AI 参谋。</small>
            </article>
          </div>
          <RecentTasks items={recentDiscussions} onOpen={handleOpenDiscussion} />
        </section>
      ) : isFileMode ? (
        <section className="file-workspace" aria-label={isFileResult ? "录音转写结果" : "上传录音转写"}>
          <header className="file-workspace-header">
            <div>
              <button
                type="button"
                className="quiet-button"
                style={{ display: "block", marginBottom: 18, borderColor: "#7785db", color: "#293a92", background: "#f0f3ff", fontWeight: 800 }}
                disabled={isTaskBusy}
                onClick={handleReturnHome}
              >
                ← 返回首页
              </button>
              <span>{isFileResult ? "TRANSCRIPT RESULT" : "FILE TRANSCRIPTION"}</span>
              <h1>{isFileResult ? "转写结果" : "上传录音转写"}</h1>
              <p>{isFileResult ? "逐字稿已进入时间线，可校正说话人并导出。" : "先选择文件，再确认转写方式；选择文件不会立即上传。"}</p>
            </div>
          </header>

          {!isFileResult ? (
            <div className="file-preflight-grid">
              <section className="file-picker-card">
                <input
                  ref={primaryFunasrInputRef}
                  id="file-transcription-input"
                  type="file"
                  accept="audio/*,video/*"
                  hidden
                  disabled={isAudioFileUploading}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) handleChooseAudioFile(file);
                    event.currentTarget.value = "";
                  }}
                  onDragEnter={(event) => event.preventDefault()}
                />
                {selectedAudioFile ? (
                  <div className="selected-file-card">
                    <span className="file-token" aria-hidden="true">AUDIO</span>
                    <div>
                      <strong>{selectedAudioFile.name}</strong>
                      <small>{formatFileSize(selectedAudioFile.size)} · 等待开始</small>
                    </div>
                    <button type="button" disabled={isAudioFileUploading} onClick={handleClearAudioFile}>移除</button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="file-drop-target"
                    disabled={isAudioFileUploading}
                    onClick={() => primaryFunasrInputRef.current?.click()}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const file = event.dataTransfer.files?.[0];
                      if (file) handleChooseAudioFile(file);
                    }}
                  >
                    <strong>选择或拖放录音文件</strong>
                    <span>支持 M4A、MP3、WAV 等常见格式</span>
                  </button>
                )}
                {selectedAudioFile ? (
                  <button type="button" className="replace-file" disabled={isAudioFileUploading} onClick={() => primaryFunasrInputRef.current?.click()}>重新选择文件</button>
                ) : null}
              </section>

              <section className="file-options-card">
                <fieldset disabled={isAudioFileUploading}>
                  <legend>选择转写方式</legend>
                  <label className={form.asrProvider === "volcengine-file" ? "provider-choice selected" : "provider-choice"}>
                    <input type="radio" name="file-provider" value="volcengine-file" checked={form.asrProvider === "volcengine-file"} onChange={() => setForm((current) => ({ ...current, asrProvider: "volcengine-file" }))} />
                    <span><strong>火山录音文件识别 2.0 <em>推荐</em></strong><small>录音会上传到火山引擎；本工作台当前限制 200MB。</small></span>
                  </label>
                  <label className={form.asrProvider === "funasr" ? "provider-choice selected" : "provider-choice"}>
                    <input type="radio" name="file-provider" value="funasr" checked={form.asrProvider === "funasr"} onChange={() => setForm((current) => ({ ...current, asrProvider: "funasr" }))} />
                    <span><strong>本地 FunASR <em>隐私优先</em></strong><small>只在本机处理；准确度可能低于火山。</small></span>
                  </label>
                </fieldset>
                <label className="file-meta-field">转写名称（可选）<input value={fileTranscriptionName} placeholder="未填写时使用文件名" disabled={isAudioFileUploading} onChange={(event) => setFileTranscriptionName(event.target.value)} /></label>
                <label className="file-meta-field">会议说明（可选）<textarea value={form.background} disabled={isAudioFileUploading} placeholder="例如：客户访谈、项目复盘" onChange={(event) => setForm({ ...form, background: event.target.value })} /></label>
                <label className="file-meta-field">已知说话人姓名（可选）<input value={form.participants.map((item) => item.displayName).join("，")} disabled={isAudioFileUploading} placeholder="用逗号分隔，例如：项目经理，客户经理" onChange={(event) => setForm((current) => ({ ...current, participants: parseKnownSpeakers(event.target.value) }))} /></label>
              </section>
            </div>
          ) : null}

          {discussion ? (
            <section className="file-result-summary" aria-label="转写摘要">
              <div><span>文件</span><strong>{selectedAudioFile?.name || discussion.title}</strong></div>
              <div><span>转写方式</span><strong>{discussion.asrProvider === "volcengine-file" ? "火山录音文件识别 2.0" : "本地 FunASR"}</strong></div>
              <div><span>转写片段</span><strong>{finalUtteranceCount} 条</strong></div>
            </section>
          ) : null}

          {isFileResult && discussion ? (
            <section className="file-result-layout">
              <section className="conversation-panel file-result-transcript">
                <header className="panel-heading"><div><span>FULL TRANSCRIPT</span><h2>完整逐字稿</h2></div><div className="transcript-health">已保存到本机</div></header>
                <div className="conversation-feed file-result-feed">{conversationItems.map((item) => <ConversationEntry discussion={discussion} item={item} key={item.id} />)}</div>
              </section>
              <aside className="file-result-actions">
                <h2>结果操作</h2>
                <a href={discussionMarkdownExportUrl(discussion.id, workspaceScope)}>导出 Markdown</a>
                <a href={discussionPackageExportUrl(discussion.id, workspaceScope)}>导出讨论包</a>
                <button type="button" disabled={isInvitingCodex} onClick={handleInviteCodex}>{isInvitingCodex ? "AI 正在整理" : "让 AI 整理会议纪要"}</button>
                <button type="button" disabled={isTaskBusy} onClick={() => { setDiscussion(null); setSelectedAudioFile(null); setFileTranscriptionName(""); setErrorMessage(null); setLocalStatus(null); }}>重新上传录音</button>
              </aside>
            </section>
          ) : null}

          {speakerLabels.length > 0 && discussion ? (
            <section className="voice-binding-strip" aria-label="说话人校正"><strong>说话人校正</strong>{speakerLabels.map((label) => <div className="voice-binding" key={label}><span>{humanSpeakerLabel(label)}</span>{discussion.participants.map((participant) => <button type="button" key={participant.id} onClick={() => handleBindSpeaker(label, participant)}>标为 {participant.displayName}</button>)}</div>)}</section>
          ) : null}

          {!isFileResult ? (
            <section className="file-primary-action" aria-live="polite">
              <button type="button" disabled={!selectedAudioFile || isAudioFileUploading} aria-busy={isAudioFileUploading} onClick={() => void handleStartFileTranscription()}>{isAudioFileUploading ? "正在上传并识别，请勿重复操作" : discussion ? "重试转写" : "开始转写"}</button>
              <span>{localStatus || (selectedAudioFile ? "等待开始" : "请先选择录音文件")}</span>
            </section>
          ) : null}
          {errorMessage && !isSettingsOpen ? <div className="file-error" role="alert"><strong>转写失败</strong><span>{errorMessage}</span></div> : null}
        </section>
      ) : (
      <section className="workspace-canvas" aria-label="实时会议助手">
        <div className="topic-stage">
          <div className="meeting-status">
            <span className={isRecording ? "status-orb live" : "status-orb"} aria-hidden="true" />
            <span>{phaseLabel(phase)}</span>
            {discussion ? <small>{finalUtteranceCount} 条有效片段</small> : null}
          </div>
          {!discussion ? (
            <label className="topic-editor">
              <span>让每一次会议<br />都成为企业资产</span>
              <textarea
                value={form.background}
                placeholder="写下会议主题、目标和背景。AI 会结合客户档案与历史记忆参与讨论。"
                onChange={(event) => setForm({ ...form, background: event.target.value })}
              />
            </label>
          ) : (
            <button type="button" className="topic-node-large" onClick={() => setIsSettingsOpen(true)}>
              <span>AI 参与企业会议</span>
              <strong>实时理解讨论，协同判断，沉淀企业知识</strong>
              <small>从会议实录到行动建议，让每一次沟通都成为下一次决策的上下文。</small>
            </button>
          )}
          <small>{cloudNotice(form.brainProvider, form.asrProvider)}</small>
        </div>

        <section className="meeting-command-center" aria-label="会议轨迹">
          <section className="conversation-panel">
            <header className="panel-heading">
              <div>
                <span>Live transcript</span>
                <h2>会议实录</h2>
              </div>
              <div className="transcript-health">
                <span className={asrStatus === "receiving" || asrStatus === "connected" ? "health-dot online" : "health-dot"} />
                {isRecording
                  ? "实时记录中"
                  : finalUtteranceCount > 0
                    ? "已保存到本机"
                    : discussion?.asrProvider === "funasr" || discussion?.asrProvider === "volcengine-file"
                      ? "等待上传录音"
                      : "等待会议开始"}
              </div>
            </header>

            <div className="conversation-feed-shell">
              <div
                className="conversation-feed"
                ref={conversationFeedRef}
                onScroll={handleConversationScroll}
                aria-live="polite"
              >
                {conversationItems.length > 0 ? (
                  conversationItems.map((item) => (
                    <ConversationEntry discussion={discussion} item={item} key={item.id} />
                  ))
                ) : (
                  <div className="conversation-empty">
                    <span className="empty-wave" aria-hidden="true"><i /><i /><i /><i /></span>
                    <strong>{discussion ? "会议已经准备好" : "先建立本次会议"}</strong>
                    <p>
                      {discussion
                        ? discussion.asrProvider === "funasr" || discussion.asrProvider === "volcengine-file"
                          ? "点击下方“选择录音文件转写”，这里会按顺序呈现识别结果和 AI 的发言。"
                          : "点击下方“开始实时转写”，这里会按顺序呈现每个人和 AI 的发言。"
                        : "写下主题后开始会议，实时转写与 AI 建议会出现在这里。"}
                    </p>
                  </div>
                )}
              </div>
              {!isFollowingLatest && conversationItems.length > 0 ? (
                <button type="button" className="conversation-jump-latest" onClick={scrollConversationToLatest}>
                  回到最新发言 <span aria-hidden="true">↓</span>
                </button>
              ) : null}
            </div>
          </section>

          <aside className="insight-panel">
            <header className="insight-heading">
              <span className="ai-mark" aria-hidden="true">AI</span>
              <div>
                <span>Meeting Copilot</span>
                <h2>AI 会议参谋</h2>
              </div>
              <em>{isInvitingCodex ? "分析中" : latestUsableAiTurn ? "已更新" : "待命"}</em>
            </header>

            <div className={latestUsableAiTurn ? "insight-content has-answer" : "insight-content"}>
              {isInvitingCodex ? (
                <>
                  <strong>正在分析新增讨论</strong>
                  <p>AI 正在寻找盲点、风险和下一步行动，不会重复发送已经分析过的对话。</p>
                </>
              ) : latestUsableAiTurn?.response ? (
                <>
                  <strong>本轮建议</strong>
                  <p>{latestUsableAiTurn.response}</p>
                  {aiTurnSystemNotice(latestUsableAiTurn.status) ? (
                    <aside className="ai-response-system-note" role="note">
                      {aiTurnSystemNotice(latestUsableAiTurn.status)}
                    </aside>
                  ) : null}
                </>
              ) : (
                <>
                  <strong>让 AI 在关键时刻介入</strong>
                  <p>{finalUtteranceCountForNextAi > 0 ? `已有 ${finalUtteranceCountForNextAi} 条新片段可分析。` : "会议产生有效对话后，AI 会结合背景和历史记忆给出建议。"}</p>
                </>
              )}
            </div>

            <div className={isGuidanceOpen || aiGuidance.trim() ? "ai-guidance open" : "ai-guidance"}>
              <button
                type="button"
                className="ai-guidance-toggle"
                aria-expanded={isGuidanceOpen}
                onClick={() => setIsGuidanceOpen((current) => !current)}
              >
                <span aria-hidden="true">{aiGuidance.trim() ? "✓" : "+"}</span>
                {aiGuidance.trim() ? "已添加本轮引导" : "添加本轮引导（可选）"}
              </button>
              {isGuidanceOpen ? (
                <label className="ai-guidance-editor">
                  <span>希望 AI 这一次重点回答什么？</span>
                  <textarea
                    value={aiGuidance}
                    maxLength={300}
                    rows={3}
                    placeholder="例如：只分析合同风险；判断客户真实意图；不要总结，只给下一步。"
                    onChange={(event) => setAiGuidance(event.target.value)}
                  />
                  <small>
                    <span>仅影响下一次发言，成功后自动清空</span>
                    <span>{aiGuidance.length}/300</span>
                  </small>
                </label>
              ) : null}
            </div>

            <button type="button" className="insight-action" disabled={!discussion || isInvitingCodex || isFallbackLoading} onClick={handleInviteCodex}>
              {isInvitingCodex ? "AI 正在思考…" : "让 AI 分析最新讨论"}
            </button>
            {discussion?.asrProvider === "volcengine" ? (
              <p className="voice-invitation-hint">实时转写时也可以说：“AI，你怎么看这个方案？”</p>
            ) : null}

            <section className="knowledge-preview">
              <div>
                <span>Knowledge loop</span>
                <strong>会议结束后自动沉淀</strong>
              </div>
              <p>关键决策、战略方向、客户信号和行动项，将成为企业下一次决策的背景。</p>
              <div className="knowledge-tags">
                <span>战略部署</span>
                <span>关键决策</span>
                <span>客户洞察</span>
                <span>行动项</span>
              </div>
              <button type="button" onClick={() => setIsKnowledgeOpen(true)}>
                查看企业知识库 Demo <span aria-hidden="true">↗</span>
              </button>
            </section>
          </aside>
        </section>

        {speakerLabels.length > 0 && discussion ? (
          <section className="voice-binding-strip" aria-label="识别到新说话人">
            <strong>识别到新说话人</strong>
            {speakerLabels.map((label) => (
              <div className="voice-binding" key={label}>
                <span>{humanSpeakerLabel(label)}</span>
                {discussion.participants.map((participant) => (
                  <button type="button" key={participant.id} onClick={() => handleBindSpeaker(label, participant)}>
                    标为 {participant.displayName}
                  </button>
                ))}
              </div>
            ))}
          </section>
        ) : null}

        {isEnded && resumeCommand && isCommandExpanded ? (
          <section className="handoff-command" aria-label="Codex 续接命令">
            <code>{resumeCommand}</code>
            <p>{copyStatus === "已复制" ? "已复制，回到 Codex 后粘贴即可继续。" : "这条命令会把刚才的讨论上下文交回 Codex。"}</p>
          </section>
        ) : null}

        <section className="primary-action-cluster" aria-label="当前主动作">
          {!discussion ? (
            <button type="button" className="listen-button" onClick={handleStart} disabled={isStarting}>
              <span className="mic-glyph" aria-hidden="true" />
              {isStarting ? "准备中" : "开始实时会议"}
            </button>
          ) : isEnded ? (
            <>
              <button type="button" className="listen-button handoff" onClick={() => void handleCopyCodexCommand(resumeCommand)} disabled={!resumeCommand}>
                <span className="handoff-glyph" aria-hidden="true" />
                {copyStatus === "已复制" ? "已复制" : "复制会议上下文"}
              </button>
              <button type="button" className="ghost-action" onClick={handleNewDiscussion}>
                新会议
              </button>
            </>
          ) : (
            <>
              {discussion.asrProvider === "funasr" || discussion.asrProvider === "volcengine-file" ? (
                <>
                  <input
                    ref={primaryFunasrInputRef}
                    type="file"
                    accept="audio/*,video/*"
                    hidden
                    disabled={isFallbackLoading || isAudioFileUploading}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void handleUploadAudio(file);
                      event.currentTarget.value = "";
                    }}
                  />
                  <button
                    type="button"
                    className="listen-button"
                    onClick={() => primaryFunasrInputRef.current?.click()}
                    disabled={isFallbackLoading || isAudioFileUploading}
                    aria-busy={isAudioFileUploading}
                  >
                    {isAudioFileUploading ? "正在上传并识别，请勿重复操作" : "选择录音文件转写"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={isRecording || isAudioStarting ? "listen-button live" : "listen-button"}
                  onClick={toggleAudioCapture}
                  disabled={isAudioStarting || isFallbackLoading}
                  aria-busy={isAudioStarting}
                  aria-pressed={isRecording}
                >
                  <span className="mic-glyph" aria-hidden="true" />
                  {isAudioStarting ? "正在请求麦克风…" : isRecording ? "停止实时转写" : "开始实时转写"}
                </button>
              )}
              {isDemoMode ? (
                <button
                  type="button"
                  className="fallback-action"
                  disabled={isFallbackLoading || fallbackLoaded || !demoBootstrap?.fallbackAudio.available}
                  onClick={() => void handleLoadFallbackAudio()}
                >
                  {isFallbackLoading ? "正在处理兜底录音" : fallbackLoaded ? "兜底录音已载入" : "使用兜底录音"}
                </button>
              ) : null}
              <button type="button" className="agent-action" disabled={isInvitingCodex || isFallbackLoading} onClick={handleInviteCodex}>
                {isInvitingCodex ? "AI 正在思考" : "由 AI 发言"}
              </button>
              <button type="button" className="handoff-action" disabled={isFallbackLoading} onClick={handleEndDiscussion}>
                结束会议
              </button>
            </>
          )}
          {errorMessage && !isSettingsOpen ? (
            <button type="button" className="soft-warning" onClick={() => setIsSettingsOpen(true)}>
              <strong>{mainErrorText(errorMessage)}</strong>
              <span>{errorMessage}</span>
            </button>
          ) : null}
        </section>
      </section>
      )}

      <KnowledgeDemo
        discussion={discussion}
        isOpen={isKnowledgeOpen}
        latestAiResponse={latestUsableAiTurn ? aiTurnDisplayText(latestUsableAiTurn) : ""}
        onClose={() => setIsKnowledgeOpen(false)}
      />

      <HiddenSettings
        activeRecentDiscussion={activeRecentDiscussion}
        appSettings={appSettings}
        asrDiagnostics={asrDiagnostics}
        asrStatus={asrStatus}
        copyStatus={copyStatus}
        customers={customers}
        discussion={discussion}
        errorMessage={errorMessage}
        finalUtteranceCount={finalUtteranceCount}
        form={form}
        taskMode={taskMode}
        isDiagnosticsOpen={isDiagnosticsOpen}
        isAudioStarting={isAudioStarting}
        isAudioFileUploading={isAudioFileUploading}
        isFallbackLoading={isFallbackLoading}
        isOpen={isSettingsOpen}
        isRecording={isRecording}
        localStatus={localStatus}
        memoryDraft={memoryDraft}
        memoryDraftText={memoryDraftText}
        recentDiscussions={recentDiscussions}
        resumeCommand={resumeCommand}
        selectedCustomer={selectedCustomer}
        speakerLabels={speakerLabels}
        visibleTimeline={visibleTimeline}
        workspaceScope={workspaceScope}
        onBindSpeaker={handleBindSpeaker}
        onClose={() => setIsSettingsOpen(false)}
        onCopyCommand={handleCopyCodexCommand}
        onDeleteAudio={handleDeleteAudio}
        onDeleteDiscussion={handleDeleteDiscussion}
        onDraftMemory={handleDraftMemory}
        onConfirmMemory={handleConfirmMemory}
        onSetMemoryDraftText={setMemoryDraftText}
        onMarkAiFeedback={handleMarkAiFeedback}
        onOpenDiscussion={handleOpenDiscussion}
        onReconnectAsr={handleReconnectAsr}
        onSaveCustomer={handleSaveCustomer}
        onSaveSettings={handleSaveSettings}
        onSelectCustomer={handleSelectCustomer}
        onSetDiagnosticsOpen={setIsDiagnosticsOpen}
        onSetForm={setForm}
        onToggleAudio={toggleAudioCapture}
        onUploadAudio={handleUploadAudio}
      />
    </main>
  );
}

function HiddenSettings(props: {
  activeRecentDiscussion?: DiscussionSummaryDto;
  appSettings: PublicAppSettingsDto | null;
  asrDiagnostics: AsrDiagnostics;
  asrStatus: AsrStatus;
  copyStatus: string | null;
  customers: CustomerSummaryDto[];
  discussion: DiscussionDetailDto | null;
  errorMessage: string | null;
  finalUtteranceCount: number;
  form: FormState;
  taskMode: TaskMode;
  isDiagnosticsOpen: boolean;
  isAudioStarting: boolean;
  isAudioFileUploading: boolean;
  isFallbackLoading: boolean;
  isOpen: boolean;
  isRecording: boolean;
  localStatus: string | null;
  memoryDraft: MemoryDraftDto | null;
  memoryDraftText: string;
  recentDiscussions: DiscussionSummaryDto[];
  resumeCommand: string;
  selectedCustomer: CustomerDetailDto | null;
  speakerLabels: string[];
  visibleTimeline: TimelineItem[];
  workspaceScope: WorkspaceDataScope;
  onBindSpeaker: (speakerLabel: string, participant: ParticipantDto) => Promise<void>;
  onClose: () => void;
  onCopyCommand: (command: string) => Promise<void>;
  onDeleteAudio: () => Promise<void>;
  onDeleteDiscussion: () => Promise<void>;
  onDraftMemory: () => Promise<void>;
  onConfirmMemory: (content: string) => Promise<void>;
  onSetMemoryDraftText: (value: string) => void;
  onMarkAiFeedback: (aiTurnId: string, rating: "useful" | "bad") => Promise<void>;
  onOpenDiscussion: (discussionId: string) => Promise<void>;
  onReconnectAsr: () => Promise<void>;
  onSaveCustomer: () => Promise<void>;
  onSaveSettings: (update: Partial<PublicAppSettingsDto> & {
    deepseekApiKey?: string;
    openaiApiKey?: string;
    volcengineApiKey?: string;
  }) => Promise<void>;
  onSelectCustomer: (customerId: string) => Promise<void>;
  onSetDiagnosticsOpen: (value: boolean | ((current: boolean) => boolean)) => void;
  onSetForm: (form: FormState | ((current: FormState) => FormState)) => void;
  onToggleAudio: () => Promise<void>;
  onUploadAudio: (file: File) => Promise<void>;
}) {
  const {
    activeRecentDiscussion,
    appSettings,
    asrDiagnostics,
    asrStatus,
    copyStatus,
    customers,
    discussion,
    errorMessage,
    finalUtteranceCount,
    form,
    taskMode,
    isDiagnosticsOpen,
    isAudioStarting,
    isAudioFileUploading,
    isFallbackLoading,
    isOpen,
    isRecording,
    localStatus,
    memoryDraft,
    memoryDraftText,
    recentDiscussions,
    resumeCommand,
    selectedCustomer,
    speakerLabels,
    visibleTimeline,
    workspaceScope
  } = props;

  return (
    <div className={isOpen ? "settings-layer open" : "settings-layer"} aria-hidden={!isOpen}>
      <button type="button" className="settings-backdrop" onClick={props.onClose} tabIndex={isOpen ? 0 : -1} aria-label="关闭隐藏设置" />
      <aside className="settings-drawer" role="dialog" aria-modal="true" aria-label="设置">
        <header className="drawer-header">
          <div>
            <span>{taskMode === "file" ? "文件转写设置" : "实时会议设置"}</span>
            <h2>{taskMode === "file" ? "转写方式与隐私边界" : "客户、实时转写与 AI"}</h2>
          </div>
          <button type="button" onClick={props.onClose}>
            关闭
          </button>
        </header>

        {errorMessage ? <p className="drawer-alert">{errorMessage}</p> : null}
        {localStatus ? <p className="drawer-alert neutral">{localStatus}</p> : null}
        {workspaceScope === "demo" ? (
          <p className="drawer-alert demo">演示模式的数据与正常会议完全分开；重置只会清理演示空间。</p>
        ) : null}

        {taskMode !== "file" ? <section className="drawer-section">
          <h3>客户档案</h3>
          {!discussion ? (
            <>
              <label>
                选择客户
                <select value={form.customerId} onChange={(event) => void props.onSelectCustomer(event.target.value)}>
                  <option value="">未选择</option>
                  {customers.map((customer) => (
                    <option value={customer.id} key={customer.id}>
                      {customer.displayName} · {customer.memoryCount} 条记忆
                    </option>
                  ))}
                </select>
              </label>
              <label>
                客户 ID
                <input
                  value={form.customerId}
                  placeholder="alpha-consult"
                  onChange={(event) =>
                    props.onSetForm({
                      ...form,
                      customerId: event.target.value,
                      customerName: form.customerName || event.target.value
                    })
                  }
                />
              </label>
              <label>
                客户名称
                <input
                  value={form.customerName}
                  placeholder="客户公司名"
                  onChange={(event) => props.onSetForm({ ...form, customerName: event.target.value })}
                />
              </label>
              <label>
                公司档案
                <textarea
                  value={form.customerProfile}
                  onChange={(event) => props.onSetForm({ ...form, customerProfile: event.target.value })}
                />
              </label>
              <button type="button" className="quiet-button" onClick={() => void props.onSaveCustomer()}>
                保存客户档案
              </button>
            </>
          ) : (
            <div className="customer-readout">
              <strong>{selectedCustomer?.displayName || discussion.customerId || "未选择客户"}</strong>
              <span>{selectedCustomer ? `${selectedCustomer.memoryCount} 条滚动记忆` : "本次会议没有客户记忆上下文"}</span>
            </div>
          )}
        </section> : null}

        <section className="drawer-section">
          <h3>{taskMode === "file" ? "文件转写方式" : "转写与大脑"}</h3>
          <label>
            ASR 转写
            <select
              value={form.asrProvider}
              disabled={Boolean(discussion)}
              onChange={(event) => {
                const asrProvider = event.target.value as AsrProviderType;
                props.onSetForm({ ...form, asrProvider });
                void props.onSaveSettings({ asrProvider });
              }}
            >
              {taskMode === "file" ? (
                <>
                  <option value="volcengine-file">火山录音文件识别 2.0（推荐）</option>
                  <option value="funasr">本地 FunASR（隐私优先）</option>
                </>
              ) : (
                <>
                  <option value="volcengine">火山豆包流式 ASR 2.0</option>
                  <option value="mock">Mock 演示</option>
                </>
              )}
            </select>
          </label>
          {taskMode === "file" ? (
            <p className="cloud-notice">{form.asrProvider === "volcengine-file" ? "录音会上传到火山引擎。本工作台当前限制 200MB；完整原始 M4A 与 MP3 分段均已实测。" : "录音只在本机交给 FunASR 处理，不发送到火山。"}</p>
          ) : null}
          {taskMode !== "file" ? <>
          <label>
            AI 大脑
            <select
              value={form.brainProvider}
              disabled={Boolean(discussion)}
              onChange={(event) => {
                const brainProvider = event.target.value as BrainProviderType;
                const brainModel = defaultModelForBrain(brainProvider, appSettings);
                props.onSetForm({ ...form, brainProvider, brainModel });
                void props.onSaveSettings({ brainProvider, brainModel });
              }}
            >
              <option value="deepseek">DeepSeek（客户默认）</option>
              <option value="claude-cli">Claude CLI（自用/客户自带订阅）</option>
              <option value="codex-cli">Codex CLI（自用/客户自带订阅）</option>
              <option value="openai">OpenAI GPT（预留）</option>
              <option value="local-qwen">本地 Qwen（预留）</option>
              <option value="mock">Mock</option>
            </select>
          </label>
          <label>
            模型
            <input
              value={form.brainModel}
              disabled={Boolean(discussion)}
              onChange={(event) => props.onSetForm({ ...form, brainModel: event.target.value })}
              onBlur={() => void props.onSaveSettings({ brainModel: form.brainModel })}
            />
          </label>
          <label>
            DeepSeek API Key
            <input
              type="password"
              placeholder={appSettings?.keys.deepseek ? "已保存，留空不改" : "填客户自己的 key"}
              onBlur={(event) => {
                if (event.target.value.trim()) void props.onSaveSettings({ deepseekApiKey: event.target.value.trim() });
                event.currentTarget.value = "";
              }}
            />
          </label>
          <label>
            火山 ASR API Key
            <input
              type="password"
              placeholder={appSettings?.keys.volcengine ? "已保存，留空不改" : "填火山自己的 key"}
              onBlur={(event) => {
                if (event.target.value.trim()) void props.onSaveSettings({ volcengineApiKey: event.target.value.trim() });
                event.currentTarget.value = "";
              }}
            />
          </label>
          <label>
            火山流式 Resource-Id
            <input
              value={appSettings?.volcengineResourceId ?? "volc.seedasr.sauc.duration"}
              onChange={(event) => void props.onSaveSettings({ volcengineResourceId: event.target.value })}
            />
          </label>
          <p className="cloud-notice">{cloudNotice(form.brainProvider, form.asrProvider)}</p>
          </> : (
            <details className="advanced-settings">
              <summary>高级设置</summary>
              <label>
                火山 API Key
                <input type="password" placeholder={appSettings?.keys.volcengine ? "凭证已配置，留空不改" : "凭证未配置"} onBlur={(event) => { if (event.target.value.trim()) void props.onSaveSettings({ volcengineApiKey: event.target.value.trim() }); event.currentTarget.value = ""; }} />
              </label>
              <label>本地项目目录<input value={form.projectPath} onChange={(event) => props.onSetForm({ ...form, projectPath: event.target.value })} /></label>
            </details>
          )}
          {!discussion ? (
            <label>
              本地项目目录
              <input
                value={form.projectPath}
                onChange={(event) => props.onSetForm({ ...form, projectPath: event.target.value })}
              />
            </label>
          ) : (
            <code className="path-readout">{discussion.projectPath}</code>
          )}
        </section>

        {taskMode !== "file" ? <section className="drawer-section">
          <h3>参与者</h3>
          {!discussion ? (
            <div className="participant-editor">
              {form.participants.map((participant, index) => (
                <div className="participant-line" key={participant.id}>
                  <label>
                    {`参与人 ${index + 1}`}
                    <input
                      value={participant.displayName}
                      onChange={(event) =>
                        props.onSetForm((current) => ({
                          ...current,
                          participants: updateParticipant(current.participants, participant.id, { displayName: event.target.value })
                        }))
                      }
                    />
                  </label>
                  <button
                    type="button"
                    disabled={form.participants.length <= 2}
                    onClick={() => props.onSetForm((current) => ({ ...current, participants: removeParticipant(current.participants, participant.id) }))}
                  >
                    删除
                  </button>
                </div>
              ))}
              <button type="button" className="quiet-button" onClick={() => props.onSetForm((current) => ({ ...current, participants: addParticipant(current.participants) }))}>
                新增参与人
              </button>
            </div>
          ) : (
            <div className="voice-marker-list">
              {discussion.participants.map((participant) => (
                <span key={participant.id}>{participant.displayName}</span>
              ))}
            </div>
          )}
          {discussion && speakerLabels.length > 0 ? (
            <div className="speaker-map">
              <strong>识别到新声音</strong>
              {speakerLabels.map((label) => (
                <div key={label}>
                  <span>{humanSpeakerLabel(label)}</span>
                  {discussion.participants.map((participant) => (
                    <button type="button" key={participant.id} onClick={() => void props.onBindSpeaker(label, participant)}>
                      标为 {participant.displayName}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </section> : null}

        {taskMode !== "file" && discussion?.mode === "real" ? (
          <section className="drawer-section">
            <h3>会议转写</h3>
            {discussion.asrProvider === "volcengine" ? (
              <>
                <button
                  type="button"
                  className={isRecording || isAudioStarting ? "quiet-button live" : "quiet-button"}
                  onClick={() => void props.onToggleAudio()}
                  disabled={isAudioStarting || isFallbackLoading}
                  aria-busy={isAudioStarting}
                  aria-pressed={isRecording}
                >
                  {isAudioStarting ? "正在请求麦克风…" : isRecording ? "停止实时转写" : "启动实时转写"}
                </button>
                <p>状态：{isAudioStarting ? "等待浏览器麦克风授权" : statusText(asrStatus)}</p>
              </>
            ) : (
              <p>
                {discussion.asrProvider === "volcengine-file"
                  ? "当前选择火山录音文件识别 2.0，上传后录音会发送到火山引擎云端。本工作台当前限制 200MB；MP3 分段和完整原始 M4A 直传均已实测。实际双人录音被模型分成 4 组说话人，身份需要人工确认。"
                  : "当前选择本地 FunASR，使用上传录音文件识别。"}
              </p>
            )}
            <label>
              {isAudioFileUploading ? "正在上传并等待识别，请勿重复操作" : "上传录音文件"}
              <input
                type="file"
                accept="audio/*,video/*"
                disabled={isFallbackLoading || isAudioFileUploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void props.onUploadAudio(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </section>
        ) : null}

        {discussion ? (
          <section className="drawer-section">
            <h3>状态与诊断</h3>
            <button type="button" className="quiet-button" onClick={() => props.onSetDiagnosticsOpen((current) => !current)}>
              {isDiagnosticsOpen || asrStatus === "failed" ? "收起诊断" : "查看诊断"}
            </button>
            {isDiagnosticsOpen || asrStatus === "failed" ? (
              <div className="diagnostics-list">
                {diagnosticItems(asrDiagnostics).map((item) => (
                  <span className={item.done ? "done" : ""} key={item.label}>
                    {item.label}
                  </span>
                ))}
                {asrDiagnostics.errorMessage ? <p>{asrDiagnostics.errorMessage}</p> : null}
                {asrDiagnostics.retryable ? (
                  <button type="button" className="quiet-button" onClick={() => void props.onReconnectAsr()}>
                    重新连接转写
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {taskMode !== "file" ? <section className="drawer-section">
          <h3>实时转写</h3>
          {visibleTimeline.length > 0 ? (
            <div className="transcript-drawer-list">
              {visibleTimeline.map((item) => (
                <p key={item.id}>
                  <strong>{timelineLabel(discussion, item)}</strong>
                  <span>{timelineText(item)}</span>
                </p>
              ))}
            </div>
          ) : (
            <p>{discussion ? "还没有新的讨论片段。" : "开始说之后，这里会出现完整片段列表。"}</p>
          )}
        </section> : null}

        {discussion && discussion.aiTurns.length > 0 ? (
          <section className="drawer-section">
            <h3>AI 发言反馈</h3>
            {discussion.aiTurns
              .filter(isUsableAiTurn)
              .slice(-4)
              .map((turn) => (
                <div className="feedback-line" key={turn.id}>
                  <p>{fragmentPreview(turn.response || "")}</p>
                  {turn.status === "truncated" ? <small>本次回复未完整生成</small> : null}
                  <button
                    type="button"
                    className={turn.feedbackRating === "useful" ? "selected" : ""}
                    onClick={() => void props.onMarkAiFeedback(turn.id, "useful")}
                  >
                    有用/有增量
                  </button>
                  <button
                    type="button"
                    className={turn.feedbackRating === "bad" ? "selected" : ""}
                    onClick={() => void props.onMarkAiFeedback(turn.id, "bad")}
                  >
                    蠢话/没用
                  </button>
                </div>
              ))}
          </section>
        ) : null}

        {discussion ? (
          <section className="drawer-section">
            <h3>会后记忆</h3>
            <p>{discussion.customerId ? "草稿必须人工确认后才会进入该客户滚动记忆。" : "先在会前选择客户，才能沉淀客户记忆。"}</p>
            <button type="button" className="quiet-button" disabled={!discussion.customerId || isFallbackLoading} onClick={() => void props.onDraftMemory()}>
              起草记忆
            </button>
            {memoryDraft ? (
              <label>
                记忆草稿
                <textarea
                  value={memoryDraftText}
                  onChange={(event) => props.onSetMemoryDraftText(event.target.value)}
                />
              </label>
            ) : null}
            {memoryDraft ? (
              <button
                type="button"
                className="quiet-button"
                onClick={() => void props.onConfirmMemory(memoryDraftText)}
              >
                确认入库
              </button>
            ) : null}
          </section>
        ) : null}

        <section className="drawer-section">
          <h3>最近讨论</h3>
          {activeRecentDiscussion ? (
            <button type="button" className="recent-line active" onClick={() => void props.onOpenDiscussion(activeRecentDiscussion.id)}>
              <strong>恢复进行中的讨论</strong>
              <span>{activeRecentDiscussion.topic}</span>
            </button>
          ) : null}
          {recentDiscussions
            .filter((item) => item.id !== activeRecentDiscussion?.id)
            .slice(0, 4)
            .map((item) => (
              <button type="button" className="recent-line" key={item.id} onClick={() => void props.onOpenDiscussion(item.id)}>
                <strong>{item.status === "ended" ? "已结束" : "进行中"}</strong>
                <span>
                  {item.topic} · {item.finalUtteranceCount} 片段 · {item.aiTurnCount} 次 Agent
                </span>
              </button>
            ))}
          {recentDiscussions.length === 0 ? <p>暂无历史讨论。</p> : null}
        </section>

        {discussion ? (
          <section className="drawer-section danger-zone">
            <h3>备用操作</h3>
            <p>
              最终转写 {finalUtteranceCount} 条，音频资产 {discussion.audioAssets.length} 个。
            </p>
            {resumeCommand ? (
              <button type="button" className="quiet-button" onClick={() => void props.onCopyCommand(resumeCommand)}>
                {copyStatus === "已复制" ? "已复制续接命令" : "复制续接命令"}
              </button>
            ) : null}
            <a href={discussionMarkdownExportUrl(discussion.id, workspaceScope)}>导出 Markdown</a>
            <a href={discussionPackageExportUrl(discussion.id, workspaceScope)}>导出讨论包</a>
            {discussion.audioAssets.length > 0 ? (
              <button type="button" onClick={() => void props.onDeleteAudio()}>
                删除音频
              </button>
            ) : null}
            <button type="button" className="danger-button" onClick={() => void props.onDeleteDiscussion()}>
              删除讨论
            </button>
          </section>
        ) : null}
      </aside>
    </div>
  );
}

function RecentTasks(props: {
  items: DiscussionSummaryDto[];
  onOpen: (discussionId: string) => Promise<void>;
}) {
  return (
    <section className="recent-tasks" aria-label="最近任务">
      <div className="recent-tasks-heading"><span>RECENT WORK</span><h2>最近任务</h2></div>
      {props.items.length > 0 ? (
        <div className="recent-task-list">
          {props.items.slice(0, 5).map((item) => (
            <button type="button" key={item.id} onClick={() => void props.onOpen(item.id)}>
              <span className={isFileAsrProvider(item.asrProvider) ? "task-kind file" : "task-kind live"}>{isFileAsrProvider(item.asrProvider) ? "文件转写" : "实时会议"}</span>
              <strong>{item.topic}</strong>
              <small>{item.finalUtteranceCount} 条片段 · {item.status === "ended" ? "已结束" : "进行中"}</small>
            </button>
          ))}
        </div>
      ) : <p>暂无历史任务。完成一次转写或会议后，会从这里直接恢复。</p>}
    </section>
  );
}

function ConversationEntry(props: {
  discussion: DiscussionDetailDto | null;
  item: TimelineItem;
}) {
  const { discussion, item } = props;
  if (item.type === "utterance") {
    const name = speakerName(discussion, item.utterance);
    const badge = speakerBadge(discussion, item.utterance);
    const tone = speakerTone(item.utterance.speakerLabel);
    return (
      <article className={`conversation-entry human speaker-tone-${tone} ${item.utterance.isFinal ? "final" : "interim"}`}>
        <span className="speaker-avatar" aria-hidden="true">{badge}</span>
        <div className="message-card">
          <header>
            <strong>{name}</strong>
            <time>{formatTimestamp(item.utterance.startMs)}</time>
          </header>
          <p>{item.utterance.text}</p>
          {!item.utterance.isFinal ? <small>正在识别…</small> : null}
        </div>
      </article>
    );
  }

  if (item.type === "aiTurn") {
    const systemNotice = aiTurnSystemNotice(item.aiTurn.status);
    return (
      <article className="conversation-entry ai">
        <span className="speaker-avatar ai-avatar" aria-hidden="true">AI</span>
        <div className="message-card">
          <header>
            <strong>AI 会议参谋</strong>
            <time>{formatClock(item.aiTurn.completedAt ?? item.aiTurn.createdAt)}</time>
          </header>
          <p>{item.aiTurn.response ?? "本轮分析已完成。"}</p>
          {systemNotice ? <aside className="ai-response-system-note" role="note">{systemNotice}</aside> : null}
        </div>
      </article>
    );
  }

  return (
    <article className="conversation-entry ai thinking">
      <span className="speaker-avatar ai-avatar" aria-hidden="true">AI</span>
      <div className="message-card">
        <header>
          <strong>AI 会议参谋</strong>
          <time>分析中</time>
        </header>
        <p>正在把最近片段组织成可推进的上下文。</p>
      </div>
    </article>
  );
}

function KnowledgeDemo(props: {
  discussion: DiscussionDetailDto | null;
  isOpen: boolean;
  latestAiResponse: string;
  onClose: () => void;
}) {
  const { discussion, isOpen, latestAiResponse, onClose } = props;
  const finalCount = discussion?.utterances.filter((utterance) => utterance.isFinal).length ?? 0;

  return (
    <div className={isOpen ? "knowledge-layer open" : "knowledge-layer"} aria-hidden={!isOpen}>
      <button type="button" className="knowledge-backdrop" onClick={onClose} aria-label="关闭企业知识库 Demo" />
      <aside className="knowledge-drawer" role="dialog" aria-modal="true" aria-label="企业知识库 Demo">
        <header className="knowledge-drawer-header">
          <div>
            <span>Enterprise memory</span>
            <h2>企业知识库</h2>
          </div>
          <div className="knowledge-drawer-actions">
            <button type="button" onClick={onClose} aria-label="关闭">×</button>
          </div>
        </header>

        <section className="knowledge-intro">
          <span className="knowledge-signal" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <strong>企业的每一次讨论，都在训练自己的决策上下文</strong>
            <p>会议结束后，系统将关键决策、战略方向、客户信号和行动项沉淀为可追溯知识。下一次开会，AI 不再从零开始。</p>
          </div>
        </section>

        <section className="knowledge-metrics" aria-label="知识库演示指标">
          <article><strong>128</strong><span>场会议已沉淀</span><small>较上月 +18</small></article>
          <article><strong>36</strong><span>项关键决策</span><small>9 项待复盘</small></article>
          <article><strong>12</strong><span>条战略主线</span><small>覆盖 4 个部门</small></article>
          <article><strong>8</strong><span>项风险预警</span><small>3 项需跟进</small></article>
        </section>

        <section className="knowledge-current-meeting">
          <header>
            <div>
              <span>本次会议即将沉淀</span>
              <h3>AI 参与企业会议：实时协同与知识沉淀</h3>
            </div>
            <em>{finalCount} 条有效片段</em>
          </header>
          <div className="knowledge-extracts">
            <article>
              <span>关键决策</span>
              <p>{latestAiResponse ? fragmentPreview(latestAiResponse) : "AI 将从会议内容中提炼已确认的选择、负责人和判断依据。"}</p>
            </article>
            <article>
              <span>后续行动</span>
              <p>把明确的任务、负责人和时间节点转为可跟踪的行动项。</p>
            </article>
          </div>
        </section>

        <section className="knowledge-library">
          <header>
            <span>Knowledge map</span>
            <h3>企业知识地图</h3>
          </header>
          <div className="knowledge-card-grid">
            <article><span>01</span><strong>战略部署</strong><p>长期目标、阶段重点与资源取舍</p><em>24 条知识</em></article>
            <article><span>02</span><strong>关键决策</strong><p>结论、依据、参与者与后续结果</p><em>36 条知识</em></article>
            <article><span>03</span><strong>客户洞察</strong><p>需求变化、异议、承诺与合作信号</p><em>51 条知识</em></article>
            <article><span>04</span><strong>项目进展</strong><p>里程碑、阻塞点、负责人和复盘</p><em>67 条知识</em></article>
          </div>
        </section>

        <section className="knowledge-evolution">
          <header><span>AI 如何越来越懂企业</span><strong>从单次助理到企业决策伙伴</strong></header>
          <ol>
            <li><span>01</span><div><strong>第一次会议</strong><p>理解本次对话与显式背景</p></div></li>
            <li><span>02</span><div><strong>持续积累</strong><p>连接历史决策、客户与项目脉络</p></div></li>
            <li><span>03</span><div><strong>企业级 AI</strong><p>在权限范围内提供更贴合战略的建议</p></div></li>
          </ol>
        </section>

        <footer className="knowledge-demo-note">
          <strong>演示边界</strong>
          <p>当前页面仅展示产品形态，不读取真实企业知识库。正式版本需接入客户授权的数据源、权限体系与可追溯引用。</p>
        </footer>
      </aside>
    </div>
  );
}

function sessionPhase(input: {
  copyStatus: string | null;
  discussion: DiscussionDetailDto | null;
  finalUtteranceCount: number;
  isInvitingCodex: boolean;
  isRecording: boolean;
}): SessionPhase {
  if (!input.discussion) return "ready";
  if (input.discussion.status === "ended") return input.copyStatus === "已复制" ? "handoff-copied" : "handoff-ready";
  if (input.isInvitingCodex) return "agent-thinking";
  if (input.discussion.aiTurns.some((turn) => isUsableAiTurnStatus(turn.status))) return "agent-joined";
  if (input.finalUtteranceCount > 0) return "capturing";
  return input.isRecording ? "listening" : "ready";
}

function phaseLabel(phase: SessionPhase): string {
  const labels: Record<SessionPhase, string> = {
    ready: "准备会议",
    listening: "实时转写中",
    capturing: "会议进行中",
    "agent-thinking": "AI 思考中",
    "agent-joined": "AI 已参与",
    "handoff-ready": "会议已结束",
    "handoff-copied": "上下文已复制"
  };
  return labels[phase];
}

function defaultCustomerProfile(customerId: string): string {
  return [
    `# ${customerId || "新客户"} 公司档案`,
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

function defaultModelForBrain(provider: BrainProviderType, settings: PublicAppSettingsDto | null): string {
  if (provider === "deepseek") return settings?.deepseekModel || "deepseek-v4-pro";
  if (provider === "claude-cli") return settings?.claudeModel || "opus";
  if (provider === "codex-cli") return settings?.codexModel || "";
  if (provider === "openai") return settings?.openaiModel || "gpt-5.6";
  if (provider === "local-qwen") return "qwen-local";
  return "mock";
}

function cloudNotice(brainProvider: BrainProviderType, asrProvider: AsrProviderType): string {
  const exitsMachine: string[] = [];
  if (brainProvider === "deepseek" || brainProvider === "openai") exitsMachine.push("AI 大脑");
  if (asrProvider === "volcengine") exitsMachine.push("实时转写音频");
  if (asrProvider === "volcengine-file") exitsMachine.push("上传的录音文件");
  if (exitsMachine.length === 0) return "本地 CLI / FunASR 路径：会议数据默认不出机。";
  return `${exitsMachine.join("、")}会调用云端服务，请只使用客户自己的 key 和授权数据。`;
}

function statusText(status: AsrStatus): string {
  if (status === "connected" || status === "receiving") return "转写中";
  if (status === "connecting") return "连接中";
  if (status === "failed") return "转写暂不可用";
  if (status === "closed") return "已停止";
  return "待命";
}

function diagnosticItems(diagnostics: AsrDiagnostics): Array<{ label: string; done: boolean }> {
  return [
    { label: "麦克风已授权", done: diagnostics.micAuthorized },
    { label: "音频发送中", done: diagnostics.audioSending },
    { label: "ASR 已连接", done: diagnostics.asrConnected },
    { label: "已收到 ASR 返回", done: diagnostics.asrReceiving },
    { label: "ASR 异常", done: Boolean(diagnostics.errorMessage) }
  ];
}

function countFinalUtterancesSinceLastAiTurn(discussion: DiscussionDetailDto): number {
  const finalUtterances = discussion.utterances.filter((utterance) => utterance.isFinal);
  const processedAiTurns = discussion.aiTurns.filter((turn) => isUsableAiTurnStatus(turn.status));
  const lastAiTurn = processedAiTurns.at(-1);
  if (!lastAiTurn) return finalUtterances.length;
  if (lastAiTurn.triggerEndUtteranceId) {
    const boundaryIndex = finalUtterances.findIndex((utterance) => utterance.id === lastAiTurn.triggerEndUtteranceId);
    return boundaryIndex >= 0 ? finalUtterances.slice(boundaryIndex + 1).length : finalUtterances.length;
  }
  if (lastAiTurn.completedAt) {
    const completedAt = lastAiTurn.completedAt;
    return finalUtterances.filter((utterance) => utterance.createdAt > completedAt).length;
  }
  return finalUtterances.length;
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  }
}

function speakerName(discussion: DiscussionDetailDto | null, utterance: UtteranceDto): string {
  const participant = discussion?.participants.find((item) => item.id === utterance.participantId);
  return participant?.displayName ?? humanSpeakerLabel(utterance.speakerLabel);
}

function speakerBadge(discussion: DiscussionDetailDto | null, utterance: UtteranceDto): string {
  const participant = discussion?.participants.find((item) => item.id === utterance.participantId);
  if (!participant) return speakerLetter(utterance.speakerLabel);
  const genericParticipantMatch = participant.displayName.trim().match(/(?:参与人|说话人)\s*([A-Z])$/i);
  return genericParticipantMatch?.[1]?.toUpperCase() ?? participant.displayName.trim().slice(0, 1);
}

function humanSpeakerLabel(speakerLabel: string): string {
  return `说话人 ${speakerLetter(speakerLabel)}`;
}

export function speakerLetter(speakerLabel: string): string {
  const match = speakerLabel.match(/(\d+)(?!.*\d)/);
  if (!match) return speakerLabel.trim().slice(0, 1).toUpperCase() || "?";
  let value = Number(match[1]) + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function speakerTone(speakerLabel: string): number {
  const match = speakerLabel.match(/(\d+)(?!.*\d)/);
  if (match) return Number(match[1]) % 8;
  return Array.from(speakerLabel).reduce((total, character) => total + character.charCodeAt(0), 0) % 8;
}

function timelineLabel(discussion: DiscussionDetailDto | null, item: TimelineItem): string {
  if (item.type === "utterance") return speakerName(discussion, item.utterance);
  if (item.type === "aiTurn") return "Agent";
  return "Agent";
}

function timelineText(item: TimelineItem): string {
  if (item.type === "utterance") return item.utterance.text;
  if (item.type === "aiTurn") return aiTurnDisplayText(item.aiTurn);
  return "Agent 正在思考...";
}

function fragmentPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 88) return normalized;
  return `${normalized.slice(0, 86)}...`;
}

function formatTimestamp(ms?: number): string {
  if (!ms) return "00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatClock(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function float32ToPcm16(input: Float32Array, sourceSampleRate: number, targetSampleRate: number): ArrayBuffer {
  const outputLength = Math.max(1, Math.floor((input.length * targetSampleRate) / sourceSampleRate));
  const output = new ArrayBuffer(outputLength * 2);
  const view = new DataView(output);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = Math.min(input.length - 1, Math.floor((index * sourceSampleRate) / targetSampleRate));
    const sample = Math.max(-1, Math.min(1, input[sourceIndex]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return output;
}
