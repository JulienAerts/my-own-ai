import { useEffect, useRef, useState } from 'preact/hooks';
import { deleteAllChats, getConversation, getSetting, loadChat, newChatId, saveChat, setSetting } from '../db';
import { formatMB, type ModelInfo } from '../models';
import { engine, Comlink } from '../worker/client';
import { reload, start } from '../boot';
import { activeImageIndex, dialectFor, imageDialect, type ChatEntry, type DialectName } from '../agent/dialects';
import { runAgent } from '../agent/loop';
import { updateSummary } from '../agent/summary';
import { promptMemories } from '../agent/loop';
import { bigEnoughForMemory, extractMemories, worthReading } from '../memory/extract';
import { autoMemoryOn, deleteMemory, ensureMemorySearch, restoreMemories } from '../memory/memory';
import { isGpuFailure, isSamplerGlitch } from '../worker/errors';
import { usePwa, applyUpdate, signInAgain } from '../pwa';
import { Mic } from './Mic';
import { CodeBlock, Markdown } from './markdown';
import { resetSandbox } from '../sandbox/sandbox';
import { CopyButton } from './copy';
import { GpuReport } from './GpuReport';
import { SettingsDialog } from './SettingsDialog';
import { BrainIcon, BulbIcon, ChevronIcon, CodeIcon, CloseIcon, EditIcon, FileIcon, PaperclipIcon, GearIcon, GlobeIcon, HistoryIcon, NewChatIcon, RetryIcon, SendIcon, SpeakerIcon, StopIcon, ToolIcon, VoiceIcon } from './icons';
import { HistoryPanel } from './HistoryPanel';
import { VoiceMode } from './VoiceMode';
import type { SettingsTab } from './SettingsDialog';
import { speakText, startSpeaking, stopSpeaking, unlockAudio, useTts, type SpeechStream } from '../tts';
import { DOC_TOOL, findTool, runTool, toolsForTurn, type ToolContext } from '../agent/tools';
import { ACCEPT } from '../docs/extract';
import { ingest, type IngestStage } from '../docs/store';
import { imageFromClipboard, isImage, prepareImage } from './image';
import { bootState, imageTokenBudget, modelChoices, nativeGpu, visionHelper } from '../boot';
import { useEnabledTools } from '../agent/toolPrefs';
import { useGenSettings } from '../agent/genPrefs';
import { DEFAULT_ASSISTANT, assistantById, memoryOwner, useAssistants } from '../assistants/assistants';
import { AssistantPicker } from './AssistantPicker';
import { replaceTurn, switchVersion, switcherPlaces, versionsAt } from '../versions';
import { TOOLS, type ToolDef } from '../agent/tools';
import { mcpToolsForTurn, startMcp, useMcp, type Approval, type ApprovalRequest } from '../mcp/mcp';
import { SKILL_TOOLS, skillsForTurn } from '../skills/skills';
import { folderTools, startFolders, useFolders } from '../files/workspace';
import { imageTools } from '../native/images';
import { nativePythonEnabled, pythonTools } from '../native/python';
import { startDesktop } from '../desktop/desktop';
import { installUpdate, startUpdateChecks, useUpdate } from '../desktop/updates';
import { isDesktopApp } from '../native';
import { locale, t, tn } from '../i18n/i18n';
import { AssistantMark } from './AssistantMark';

// Dev/testing override: ?dialect=hermes|json before the hash.
function dialectOverride(): DialectName | null {
  const d = new URLSearchParams(location.search).get('dialect');
  return d === 'hermes' || d === 'json' ? d : null;
}

// Survives the remount that a model reload causes.
let pendingNotice: string | null = null;


const TOOL_STATUS: Record<string, () => string> = {
  search_documents: () => t('Searching your documents'),
  remember: () => t('Saving to memory'),
  forget: () => t('Updating memory'),
  recall_chats: () => t('Searching past conversations'),
  memory: () => t('Updating memory'),
  run_code: () => t('Running code'),
  use_skill: () => t('Opening a skill'),
  list_files: () => t('Looking in your folder'),
  search_files: () => t('Looking for files'),
  read_file: () => t('Reading the file'),
  search_folder: () => t('Searching your files'),
  write_file: () => t('Saving the file'),
  generate_image: () => t('Creating the image'),
  run_python_local: () => t('Running Python on your PC'),
  read_skill_file: () => t('Reading a skill file'),
  search: () => t('Searching the web'),
  news: () => t('Checking the news'),
  read_page: () => t('Reading the page'),
  read_article: () => t('Reading Wikipedia'),
  weather: () => t('Checking the weather'),
  convert_currency: () => t('Getting exchange rates'),
  define_word: () => t('Looking it up'),
  convert_units: () => t('Converting'),
  calculator: () => t('Calculating'),
  get_datetime: () => t('Checking the time'),
};

export function ChatPage({ modelId, model, contextWindow }: { modelId: string; model: ModelInfo; contextWindow: number }) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [partial, setPartial] = useState<{
    text: string | null | undefined;
    step: number;
    tool?: string;
    detail?: string;
    /** A reasoning model's thoughts in this step, as they stream. */
    thought?: { text: string; done: boolean; secs?: number };
  } | null>(null);
  /** Reasoning models: think before answering (the Think switch). */
  const [think, setThink] = useState(true);
  /** Tokens the last model call used, for the memory gauge. */
  const [usage, setUsage] = useState<number | null>(null);
  const gen = useGenSettings(modelId);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(pendingNotice);
  const [settings, setSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('model');
  const [voiceMode, setVoiceMode] = useState(false);
  const runningRef = useRef(false);
  const signal = useRef({ stopped: false });
  const bottom = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pwa = usePwa();
  const [chatId, setChatId] = useState('');
  const [history, setHistory] = useState(false);
  const [picker, setPicker] = useState(false);
  /** A connector tool waiting for the user's OK. */
  const [approval, setApproval] = useState<{ req: ApprovalRequest; resolve(a: Approval): void } | null>(null);
  const voice = useTts();

  const [ingesting, setIngesting] = useState<{ name: string; stage: IngestStage; fraction: number; queued: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Image waiting to be sent with the next message (vision models). */
  const [pendingImage, setPendingImage] = useState<{ url: string; tokens: number } | null>(null);

  const { tools: enabled } = useEnabledTools();
  // The assistant this conversation is with: its tools, documents, memory and role.
  const [assistantId, setAssistantId] = useState<string | undefined>(undefined);
  useAssistants(); // re-render when assistants are edited
  const assistant = assistantById(assistantId);
  const memoryId = memoryOwner(assistant);
  const role = assistant.id === DEFAULT_ASSISTANT.id ? undefined : { name: assistant.name, instructions: assistant.instructions };
  const docIdsOf = (list: ChatEntry[]) => [...new Set([...(assistant.docIds ?? []), ...list.flatMap((e) => (e.role === 'doc' ? [e.docId] : []))])];
  const hasDocs = entries.some((e) => e.role === 'doc') || !!assistant.docIds?.length;
  // The document search tool only exists in conversations with documents.
  // An assistant with its own tool list uses it instead of the defaults (still only tools this build has).
  const baseTools = assistant.tools ? TOOLS.filter((t) => assistant.tools!.includes(t.name)) : enabled;
  const tools = hasDocs ? [...baseTools, DOC_TOOL] : baseTools;
  const thinking = !!model.reasoning && think;
  /** The prompt format for a turn; small contexts get only the tools the message needs. */
  useMcp(); // re-render when connectors come up (their tools join the list)
  /**
   * Tools for a turn: small contexts get only those the message needs; MCP
   * connectors add their most relevant tools (the default assistant, or one that lists them).
   */
  const toolsForMessage = (message: string) => {
    const mcp = isDesktopApp ? mcpToolsForTurn(message, contextWindow <= 4096 ? 6 : 12) : [];
    // Workspace folders (desktop): the folder tools, unless an assistant has its own list without them.
    const files = [...folderTools(), ...imageTools(nativeGpu?.vramMB), ...pythonTools()].filter((t) => !assistant.tools || assistant.tools.includes(t.name));
    return [...toolsForTurn(tools, message, contextWindow), ...files, ...(assistant.tools ? mcp.filter((t) => assistant.tools!.includes(t.name)) : mcp)];
  };
  const dialectForTurn = (turnTools: ToolDef[]) => dialectFor(dialectOverride() ?? (model.hermes ? 'hermes' : 'json'), {
    toolRole: model.hermes, tools: turnTools, reasoning: model.reasoning, thinking,
  });
  // Thoughts count against the answer's tokens: leave room for them (and the answer).
  // A custom length (Settings → Model → Generation) applies to every turn, at most
  // half the context, so the question and recent messages still fit.
  const maxTokens = Math.min(gen.maxTokens ?? (thinking ? (contextWindow <= 2048 ? 1024 : 2048) : 512), Math.floor(contextWindow / 2));
  // Tool results (excerpts, pages, search results) must leave room for the answer:
  // 1,300 characters in a phone's 2048-token context, more with a bigger context.
  const docBudget = contextWindow <= 2048 ? 1300 : Math.min(8000, Math.round(2400 * (contextWindow / 4096)));
  const maxSteps = model.tier === 'tiny' ? 3 : 5;

  // Reopen the last conversation (the pre-history single chat was stored as "default").
  // Desktop: start the MCP connectors (their tools show up when ready).
  useEffect(() => { if (isDesktopApp) { void startMcp(); void startFolders(); void nativePythonEnabled(); startUpdateChecks(); } }, []);
  // While the model writes, background and logo animations stop: phones share the GPU with it.
  useEffect(() => {
    document.documentElement.toggleAttribute('data-busy', running);
    return () => document.documentElement.removeAttribute('data-busy');
  }, [running]);
  const update = useUpdate();
  // Ctrl+Alt+Space (or the tray's "New chat"): a fresh conversation, ready to type.
  const quickAsk = useRef(() => {});
  quickAsk.current = () => { if (!runningRef.current) newChat(); inputRef.current?.focus(); };
  useEffect(() => {
    let off = () => {};
    void startDesktop(() => quickAsk.current()).then((fn) => { off = fn; });
    return () => off();
  }, []);
  useFolders(); // re-render when folders change (their tools)

  useEffect(() => {
    getSetting('thinking').then((v) => v !== undefined && setThink(v), () => {});
  }, []);

  function toggleThink() {
    setThink(!think);
    setSetting('thinking', !think);
  }

  useEffect(() => {
    pendingNotice = null;
    (async () => {
      const id = (await getSetting('currentChat')) ?? 'default';
      await openChat(id);
    })();
  }, []);

  /** `withAssistant`: for a new conversation, who it's with (an existing one keeps its own). */
  async function openChat(id: string, withAssistant?: string) {
    const [e, meta] = await Promise.all([loadChat(id), getConversation(id)]);
    setAssistantId(meta?.assistantId ?? withAssistant);
    setChatId(id);
    setEntries(e);
    setError(null);
    setUsage(null);
    // Code variables belong to one conversation.
    resetSandbox();
    setLoaded(true);
    await setSetting('currentChat', id);
  }

  /** A new conversation: with the same assistant, or `null` for the default one, or another one's id. */
  function newChat(withAssistant?: string | null) {
    // Not saved until the first message, so empty conversations never pile up.
    openChat(newChatId(), withAssistant === undefined ? assistantId : withAssistant ?? undefined);
    inputRef.current?.focus();
  }

  // Unmounting (e.g. switching models) stops a generation instead of letting it run unseen.
  useEffect(() => () => {
    if (runningRef.current) {
      signal.current.stopped = true;
      engine().interrupt();
    }
  }, []);

  // Follow the conversation while it grows, unless the user scrolled up to read:
  // then a ↓ button brings them back. Instant, not smooth: a smooth scroll per
  // streamed token keeps the compositor busy on the same GPU the model is running on.
  const stick = useRef(true);
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  function onScroll(ev: Event) {
    const el = ev.currentTarget as HTMLElement;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    setAwayFromEnd(!near);
  }
  function toLatest() {
    stick.current = true;
    setAwayFromEnd(false);
    bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }
  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [entries, partial]);

  /**
   * `speak`: read the answer aloud even when auto-read is off (voice mode).
   * `base`: the conversation to answer from, when editing or regenerating
   * (everything after it is replaced); the composer draft is then kept.
   */
  async function send(raw = input, opts: { speak?: boolean; base?: ChatEntry[]; image?: { url: string; tokens?: number } } = {}) {
    const text = raw.trim();
    // A message from the composer carries the pending image; edits and regenerations pass theirs.
    const image = opts.base ? opts.image : (pendingImage ?? undefined);
    if ((!text && !image) || runningRef.current) return;
    // A text model can't see a new image: hand this turn to the vision model, then switch back.
    const helper = image && !model.vision ? visionHelper() : null;
    if (helper) {
      runningRef.current = true; // no second send while we check the cache
      const [st] = await engine().cacheStatuses([helper.id]).catch(() => []);
      runningRef.current = false;
      if (!st?.complete && !confirm(t(
        'Answering about images uses {helper}, a one-time {size} download. Download it now? {model} comes back right after the answer.',
        { helper: helper.model.displayName, size: formatMB(helper.model.downloadMB), model: model.displayName },
      ))) {
        setError(t('The image wasn’t sent: answering about it needs the vision model.'));
        return;
      }
    }
    const speakIt = voice.auto || !!opts.speak;
    if (!opts.base) {
      setInput('');
      setPendingImage(null);
    }
    setError(null);
    // Inside the click/keypress, so audio may start later when the reply streams in.
    stopSpeaking();
    if (speakIt) unlockAudio();
    let speech: SpeechStream | null = null;
    setRunning(true);
    runningRef.current = true;
    signal.current = { stopped: false };
    const question = { role: 'user', text, ts: Date.now(), ...(image && { image: image.url, imageTokens: image.tokens }) } as Extract<ChatEntry, { role: 'user' }>;
    // Regenerating or editing keeps what it replaces as an earlier version of the turn.
    let transcript = opts.base && entries[opts.base.length]?.role === 'user'
      ? replaceTurn(entries, opts.base.length, question)
      : [...(opts.base ?? entries), question];
    // A text-only model must never receive image content (WebLLM rejects it).
    const forModel = (list: ChatEntry[]) => model.vision || helper ? list : list.map((e) =>
      e.role === 'user' && e.image ? { ...e, image: undefined, text: `[The user shared an image here. You can't see it; rely on the answer about it, if any.]\n${e.text}` } : e);
    // A turn with a recent image leaves no room for tools: answer in plain text.
    const withImage = (!!model.vision || !!helper) && activeImageIndex(transcript) >= 0;
    let reloading = false;
    /** The final answer's text, for automatic memory. */
    let answered = '';
    // Skills relevant to this message: listed in the prompt, opened with use_skill.
    const skills = withImage ? [] : await skillsForTurn(text, contextWindow);
    const turnTools = [...toolsForMessage(text), ...(skills.length ? SKILL_TOOLS : [])];
    const dialect = dialectForTurn(turnTools);
    const turnDialect = withImage ? imageDialect() : dialect;
    setEntries(transcript);
    const id = chatId;
    saveChat(id, transcript, assistantId);
    const toolContext: ToolContext = {
      chatId: id,
      assistantId: memoryId,
      docIds: docIdsOf(transcript),
      maxChars: docBudget,
      onStatus: (detail) => setPartial((p) => p && { ...p, detail }),
      // Connector tools that may change something wait for the user's answer.
      confirm: (req) => new Promise<Approval>((resolve) => setApproval({ req, resolve })),
      // For the prompt-injection guard: what the user wrote and what tools brought in
      // (not the model's own answers, where it could have written an address itself).
      seen: () => ({
        user: transcript.flatMap((e) => (e.role === 'user' ? [e.text] : [])).join('\n'),
        all: transcript.flatMap((e) => (e.role === 'user' ? [e.text] : e.role === 'tool' ? [JSON.stringify(e.args), e.result] : [])).join('\n'),
      }),
      turnTools: () => {
        const q = transcript.map((e) => e.role).lastIndexOf('user');
        return transcript.slice(q + 1).flatMap((e) => (e.role === 'tool' ? [e.name] : []));
      },
    };
    try {
      // Fold messages that no longer fit in the context window into the rolling summary.
      if (!helper && !withImage) {
        setPartial({ text: null, step: 1, tool: 'summary', detail: t('Summarizing earlier messages…') });
        try {
          const [notes, instructions] = await Promise.all([promptMemories(transcript, contextWindow, memoryId), getSetting('instructions')]);
          const updated = await updateSummary(engine(), forModel(transcript), { dialect, contextWindow, maxTokens, ctx: { notes, instructions, role }, reasoning: model.reasoning });
          if (updated) {
            // forModel only rewrote image placeholders; keep the real entries (with images).
            const byTs = new Map(transcript.map((e) => [e.ts, e]));
            transcript = updated.map((e) => byTs.get(e.ts) ?? e);
            setEntries(transcript);
            saveChat(id, transcript, assistantId);
          }
        } catch (e) {
          if (isGpuFailure(e)) throw e;
          console.warn('Summary skipped', e); // answer anyway, with a shorter memory
        }
        setPartial(null);
      }
      // With documents attached, search them first: small models don't reliably decide to.
      if (toolContext.docIds.length && !withImage) {
        setPartial({ text: null, step: 1, tool: DOC_TOOL.name });
        const args = { query: text };
        const { result, error } = await runTool(DOC_TOOL.name, args, toolContext);
        transcript = [...transcript, { role: 'tool', name: DOC_TOOL.name, args, result, error, ts: Date.now() }];
        setEntries(transcript);
        saveChat(id, transcript, assistantId);
      }
      let window = contextWindow;
      if (helper) {
        const status = (detail: string) => setPartial({ text: null, step: 1, tool: 'vision', detail });
        status(t('Loading {model}…', { model: helper.model.displayName }));
        ({ contextWindow: window } = await engine().load(helper.id, Comlink.proxy((p) => {
          status(t('Loading {model} · {pct}%', { model: helper.model.displayName, pct: Math.floor(p.progress * 100) }));
        })));
      }
      // The vision helper answers images in plain text; only the conversation's model may think.
      const reasoning = !!model.reasoning && !helper && !withImage;
      await runAgent(engine(), forModel(transcript), {
        dialect: turnDialect,
        maxSteps: withImage ? 1 : maxSteps,
        contextWindow: window,
        // The vision helper keeps the app's defaults; the settings belong to this model.
        maxTokens: helper ? 512 : maxTokens,
        // Qwen3 loops with near-greedy sampling while thinking.
        temperature: helper ? undefined : gen.temperature ?? (reasoning && thinking ? 0.6 : undefined),
        topP: helper ? undefined : gen.topP,
        // Image turns answer in plain text: a model that thinks by default (Qwen3.5) is told not to,
        // or its thoughts would use up the answer's tokens.
        thinking: reasoning ? thinking : model.reasoning && !helper ? false : undefined,
        role,
        allowedTools: turnTools.map((t) => t.name),
        skills,
        signal: signal.current,
        toolContext,
      }, {
        onPartial: (t, step, thought) => {
          setPartial({ text: t, step, thought });
          // Read the reply as it streams, a sentence at a time.
          if (speakIt && typeof t === 'string' && t) {
            speech ??= startSpeaking(`live-${step}`);
            speech.push(t);
          }
        },
        onToolStart: (tool, step) => setPartial({ text: null, step, tool }),
        onUsage: (tokens) => !helper && setUsage(tokens),
        onEntry: (entry) => {
          if (entry.role === 'assistant' && !entry.text.trim() && !entry.interrupted) {
            // An empty answer usually means the GPU computed garbage without raising an
            // error (an invalid WebGPU operation, or NaN values). Show the diagnostics.
            entry = { ...entry, text: `_(${t('The model returned an empty answer.')})_`, notice: true };
            setError(withImage
              ? t('The model returned an empty answer to the image. This usually means a GPU problem on this device; the GPU diagnostics below can tell which.')
              : t('The model returned an empty answer. This usually means a GPU problem on this device; the GPU diagnostics below can tell which.'));
          }
          if (entry.role === 'assistant' && helper) entry = { ...entry, by: helper.model.displayName };
          if (entry.role === 'assistant' && speakIt && !entry.interrupted) {
            (speech ?? startSpeaking(String(entry.ts))).end(entry.text, String(entry.ts));
          }
          if (entry.role === 'assistant' && !entry.interrupted && !entry.notice) answered = entry.text;
          transcript = [...transcript, entry];
          setEntries(transcript);
          saveChat(id, transcript, assistantId);
          setPartial(null);
        },
      });

      // Automatic memory: note durable facts the user shared in this message.
      if (answered && !helper && !withImage && !signal.current.stopped && bigEnoughForMemory(model.params) && worthReading(text) && await autoMemoryOn()) {
        setPartial({ text: null, step: 1, tool: 'memory', detail: t('Updating memory…') });
        try {
          const { saved, replaced } = await extractMemories(engine(), { user: text, assistant: answered }, {
            reasoning: model.reasoning,
            assistantId: memoryId,
            source: { chatId: id, title: text.slice(0, 60) },
          });
          if (saved.length && !signal.current.stopped) {
            transcript = [...transcript, {
              role: 'memory', ids: saved.map((m) => m.id), texts: saved.map((m) => m.text), ts: Date.now(),
              ...(replaced.length && { replaced: replaced.map(({ vector: _v, ...m }) => m) }),
            }];
            setEntries(transcript);
            saveChat(id, transcript, assistantId);
          }
        } catch (e) {
          if (isGpuFailure(e)) throw e;
          console.warn('Automatic memory skipped', e);
        }
        setPartial(null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isSamplerGlitch(e)) {
        // The model is still loaded; only this answer failed (after retries).
        setError(t('The model kept producing an invalid token ({error}), a known WebLLM issue. Please send your message again.', { error: msg }));
        return;
      }
      if (!isGpuFailure(e)) {
        // The model is still loaded: show what went wrong instead of reloading.
        setError(t('Couldn’t answer: {error}', { error: msg }));
        return;
      }
      // The worker has already discarded the engine; reload the model from cache.
      pendingNotice = t('The GPU stopped mid-answer ({error}). On phones this happens when the app is backgrounded or the screen locks. The model was reloaded; please send your message again.', { error: msg });
      reloading = true;
      reload();
    } finally {
      // Put the conversation's model back after a vision answer (or a failed attempt).
      const back = bootState();
      if (helper && !reloading && back.kind === 'ready') {
        setPartial({ text: null, step: 1, tool: 'vision', detail: t('Switching back to {model}…', { model: model.displayName }) });
        try {
          await engine().load(back.modelId, Comlink.proxy(() => {}));
        } catch {
          reload();
        }
      }
      setPartial(null);
      setRunning(false);
      runningRef.current = false;
    }
  }

  function stop() {
    approval?.resolve('deny');
    setApproval(null);
    signal.current.stopped = true;
    engine().interrupt();
    stopSpeaking();
  }

  // Leaving a conversation or the page stops reading it.
  useEffect(() => stopSpeaking, [chatId]);

  async function deleteAll() {
    await deleteAllChats();
    newChat();
  }

  /** Append entries to the open conversation and save it. */
  function append(...added: ChatEntry[]) {
    const id = chatId;
    setEntries((prev) => {
      const next = [...prev, ...added];
      saveChat(id, next, assistantId);
      return next;
    });
  }

  /**
   * An image goes to the vision model with the next message. Other models can't
   * see it: say so right away instead of sending it (or indexing it as a document).
   */
  async function addImage(blob: Blob | null | undefined) {
    if (!blob) return;
    try {
      const image = await prepareImage(blob, imageTokenBudget());
      // The vision model answers about it: either it's loaded, or it takes over for that turn.
      if (model.vision || visionHelper()) {
        setPendingImage(image);
        inputRef.current?.focus();
        return;
      }
      // The image model this device can run: Qwen3.5 on a desktop GPU, else Phi-3.5 vision.
      const visionHere = modelChoices().find((c) => c.model.vision && c.model.fixedId?.startsWith('gguf:')) ?? modelChoices().find((c) => c.model.vision);
      const now = Date.now();
      append(
        { role: 'user', text: '', image: image.url, ts: now },
        {
          role: 'assistant',
          notice: true,
          ts: now + 1,
          text: `${t('Sorry, I can’t see images: {model} only reads text.', { model: model.displayName })} ` + (visionHere
            ? t('To ask about photos, switch to **{vision}** in Settings → Model ({size}, downloaded once).', { vision: visionHere.model.displayName, size: formatMB(visionHere.model.downloadMB) })
            : t('Image understanding needs a device with 8 GB of memory or more, so it isn’t available here.')),
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** One attach button: images go to addImage, everything else into the document store. */
  async function attach(files: FileList | null) {
    if (!files?.length || ingesting) return;
    const all = [...files];
    const images = all.filter(isImage);
    if (images.length) {
      if (model.vision && images.length > 1) setError(t('One image per message: only the first one was added.'));
      await addImage(images[0]);
    }
    const list = all.filter((f) => !isImage(f));
    if (!list.length) {
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    const id = chatId;
    for (const [i, file] of list.entries()) {
      setIngesting({ name: file.name, stage: 'reading', fraction: 0, queued: list.length - i - 1 });
      try {
        const doc = await ingest(file, (stage, fraction) => setIngesting({ name: file.name, stage, fraction, queued: list.length - i - 1 }));
        const entry: ChatEntry = { role: 'doc', docId: doc.id, name: doc.name, pages: doc.pages, passages: doc.passages, semantic: doc.semantic, ts: Date.now() };
        setEntries((prev) => {
          const next = [...prev, entry];
          saveChat(id, next, assistantId);
          return next;
        });
      } catch (e) {
        setError(t('Couldn’t add {file}: {error}', { file: file.name, error: e instanceof Error ? e.message : String(e) }));
      }
    }
    setIngesting(null);
    if (fileInput.current) fileInput.current.value = '';
    inputRef.current?.focus();
  }

  /** Forget what automatic memory saved after a turn; the chip stays, marked as undone. */
  async function undoMemory(index: number) {
    const e = entries[index];
    if (e?.role !== 'memory' || e.undone) return;
    await deleteMemory(...e.ids);
    if (e.replaced?.length) {
      await restoreMemories(e.replaced); // what the new facts had replaced comes back
      void ensureMemorySearch();
    }
    const id = chatId;
    setEntries((prev) => {
      const next = prev.map((x, j) => (j === index ? { ...e, undone: true } : x));
      saveChat(id, next, assistantId);
      return next;
    });
  }

  /** Ask the last question again, replacing its answer (and tool calls). */
  function regenerate() {
    const i = entries.map((e) => e.role).lastIndexOf('user');
    const e = entries[i];
    if (e?.role === 'user') send(e.text, { base: entries.slice(0, i), image: e.image ? { url: e.image, tokens: e.imageTokens } : undefined });
  }

  /** Show another version of the turn that starts at question `q`. */
  function showVersion(q: number, n: number) {
    if (runningRef.current) return;
    stopSpeaking();
    const next = switchVersion(entries, q, n);
    setEntries(next);
    saveChat(chatId, next, assistantId);
  }

  /** Replace a question and everything after it (kept as an earlier version). */
  function editAndResend(index: number, text: string) {
    const e = entries[index];
    send(text, { base: entries.slice(0, index), image: e?.role === 'user' && e.image ? { url: e.image, tokens: e.imageTokens } : undefined });
  }

  const lastAssistant = entries.map((e) => e.role).lastIndexOf('assistant');
  const switchers = switcherPlaces(entries);
  const empty = loaded && entries.length === 0 && !partial;
  const lastAnswer = [...entries].reverse().find((e) => e.role === 'assistant');
  const liveAnswer = typeof partial?.text === 'string' ? partial.text : partial ? '' : lastAnswer?.role === 'assistant' ? lastAnswer.text : '';

  // The assistant's preferred model, when another one is loaded and this device can run it.
  const preferred = assistant.modelId && assistant.modelId !== modelId ? modelChoices().find((c) => c.id === assistant.modelId) : undefined;

  function openSettings(tab: SettingsTab = 'model') {
    setSettingsTab(tab);
    setSettings(true);
  }

  return (
    <div class="chat">
      <header class="chat-head">
        <button class="icon-btn" onClick={() => setHistory(true)} aria-label={t('Conversations')} title={t('Conversations')}>
          <HistoryIcon />
        </button>
        <button class="brand assistant-btn" onClick={() => setPicker(true)} disabled={running} title={t('Assistants')}>
          <AssistantMark a={assistant} size={28} />
          <span class="brand-name">{assistant.name}</span>
          <ChevronIcon />
        </button>
        <button class="model-chip" onClick={() => openSettings('model')} title={`${model.displayName} · ${t('Change model')}`}>
          <span class="dot" />
          <span class="chip-full">{model.displayName}</span>
          {/* Phones: "Hermes 3" rather than "Hermes 3 (Llama 3.1 8B)", so the header keeps the assistant's name. */}
          <span class="chip-short">{model.displayName.replace(/\s*\(.*\)\s*$/, '')}</span>
        </button>
        <button
          class="icon-btn"
          onClick={() => newChat()}
          disabled={running || entries.length === 0}
          aria-label={t('New conversation')}
          title={t('New conversation')}
        >
          <NewChatIcon />
        </button>
      </header>

      {pwa.needRefresh && (
        <div class="toast">
          {t('A new version is available.')} <button class="link" onClick={() => applyUpdate()}>{t('Reload')}</button>
        </div>
      )}
      {update.kind === 'available' && !running && (
        <div class="toast">
          {t('Version {version} is available.', { version: update.version })} <button class="link" onClick={() => installUpdate()}>{t('Update and restart')}</button>
        </div>
      )}
      {update.kind === 'downloading' && (
        <div class="toast">{t('Downloading version {version}… {pct}%', { version: update.version, pct: Math.floor(update.fraction * 100) })}</div>
      )}
      {!pwa.needRefresh && pwa.signInNeeded && !running && (
        <div class="toast">
          {t('Sign in to this site again to get new versions.')} <button class="link" onClick={signInAgain}>{t('Sign in')}</button>
        </div>
      )}

      <main class="messages" aria-live="polite" onScroll={onScroll}>
        {empty && (
          <div class="hello">
            <AssistantMark a={assistant} size={72} />
            <h1>{assistant.id === DEFAULT_ASSISTANT.id ? t('How can I help?') : assistant.name}</h1>
            <p class="muted">{t('Running {model} privately on your device.', { model: model.displayName })}</p>
            {preferred && (
              <p class="notice small">
                {t('{assistant} prefers {model}.', { assistant: assistant.name, model: preferred.model.displayName })}{' '}
                <button class="link" onClick={() => start(preferred.id)}>{t('Switch to it')}</button>
              </p>
            )}
            <div class="suggestions">
              {(assistant.starters?.length ? assistant.starters : DEFAULT_ASSISTANT.starters!).map((s) => (
                <button class="suggestion" onClick={() => (s.includes('…') ? (setInput(s.replace('…', '')), inputRef.current?.focus()) : send(s))}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {entries.map((e, i) => (
          <Entry
            e={e}
            versions={switchers.has(i) ? { ...versionsAt(entries, switchers.get(i)!)!, onShow: (n) => showVersion(switchers.get(i)!, n) } : undefined}
            speaking={voice.speaking}
            busy={running}
            last={i === lastAssistant && !partial}
            onRegenerate={regenerate}
            onUndoMemory={() => undoMemory(i)}
            onManageMemory={() => openSettings('memory')}
            onEdit={(text) => editAndResend(i, text)}
          />
        ))}
        {partial?.thought && <Thinking text={partial.thought.text} secs={partial.thought.secs} live={!partial.thought.done} />}
        {partial && !(partial.thought && !partial.thought.done) && (
          typeof partial.text === 'string'
            ? <div class="msg assistant streaming"><Markdown text={partial.text} streaming /><span class="cursor" /></div>
            : (
              <div class="thinking">
                <span class="dots"><i /><i /><i /></span>
                {partial.detail ?? (partial.tool ? TOOL_STATUS[partial.tool]?.() ?? toolStatus(partial.tool) : partial.text === null ? t('Choosing a tool') : partial.thought ? t('Answering') : t('Thinking'))}
                {partial.step > 1 && <span class="muted"> · {t('step {n}/{max}', { n: partial.step, max: maxSteps })}</span>}
              </div>
            )
        )}
        {approval && (
          <ApprovalCard
            req={approval.req}
            onAnswer={(a) => { approval.resolve(a); setApproval(null); }}
          />
        )}
        {error && (
          <div class="alert small">
            {error}
            <GpuReport key={error} />
          </div>
        )}
        <div ref={bottom} />
      </main>

      <form class="composer" onSubmit={(ev) => { ev.preventDefault(); stick.current = true; send(); }}>
        {awayFromEnd && !empty && (
          <button type="button" class="to-latest" onClick={toLatest} aria-label={t('Go to the latest message')} title={t('Go to the latest message')}>
            <ChevronIcon />
          </button>
        )}
        {ingesting && (
          <div class="ingest">
            <FileIcon />
            <div class="ingest-info">
              <span class="ingest-name">{ingesting.name}</span>
              <span class="muted small">
                {ingesting.stage === 'reading' ? t('Reading') : ingesting.stage === 'model' ? t('Downloading the search model (once, 23 MB)') : t('Indexing')}
                {' '}{Math.floor(ingesting.fraction * 100)}%{ingesting.queued ? ` · ${t('{n} more', { n: ingesting.queued })}` : ''}
              </span>
              <div class="bar"><div style={{ width: `${Math.max(3, ingesting.fraction * 100)}%` }} /></div>
            </div>
          </div>
        )}
        {pendingImage && (
          <div class="pending-image">
            <img src={pendingImage.url} alt={t('Image to send')} />
            <span class="small muted">
              {t('Ask something about this image, or just send it.')}
              {!model.vision && visionHelper() && <> {t('{vision} will answer, then {model} comes back.', { vision: visionHelper()!.model.displayName, model: model.displayName })}</>}
            </span>
            <button type="button" class="icon-btn" onClick={() => setPendingImage(null)} aria-label={t('Remove image')} title={t('Remove')}><CloseIcon /></button>
          </div>
        )}
        <div class="composer-box">
          <button type="button" class="icon-btn" onClick={() => openSettings('model')} aria-label={t('Settings')} title={t('Settings')}>
            <GearIcon />
          </button>
          <button type="button" class="icon-btn" disabled={running || !!ingesting} onClick={() => fileInput.current?.click()} aria-label={t('Attach a file or photo')} title={model.vision ? t('Attach a document or a photo') : t('Attach a document (PDF, text…)')}>
            <PaperclipIcon />
          </button>
          {model.reasoning && (
            <button
              type="button"
              class={think ? 'icon-btn think-btn on' : 'icon-btn think-btn'}
              onClick={toggleThink}
              aria-pressed={think}
              aria-label={t('Think before answering')}
              title={think ? t('Thinking: on (slower, better for maths and logic). Click to answer directly.') : t('Thinking: off. Click to let the model think first.')}
            >
              <BulbIcon />
            </button>
          )}
          <input ref={fileInput} type="file" multiple accept={`${ACCEPT},image/*`} hidden onChange={(e) => attach(e.currentTarget.files)} />
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            placeholder={t('Message My Own AI')}
            onInput={(ev) => setInput(ev.currentTarget.value)}
            onPaste={(ev) => {
              // Paste a screenshot straight into the chat.
              const img = imageFromClipboard(ev);
              if (img) { ev.preventDefault(); addImage(img); }
            }}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(); }
            }}
          />
          <Mic
            disabled={running}
            onText={(t) => setInput((cur) => (cur.trim() ? `${cur.trimEnd()} ${t}` : t))}
            onError={setError}
          />
          {!input.trim() && !running && 'mediaDevices' in navigator && (
            <button type="button" class="icon-btn" onClick={() => { unlockAudio(); setVoiceMode(true); }} aria-label={t('Voice mode')} title={t('Voice mode: talk hands-free')}>
              <VoiceIcon />
            </button>
          )}
          {running
            ? <button type="button" class="send-btn" onClick={stop} aria-label={t('Stop')}><StopIcon /></button>
            : <button type="submit" class="send-btn" disabled={(!input.trim() && !pendingImage) || !!ingesting} aria-label={t('Send')}><SendIcon /></button>}
        </div>
        <div class="composer-note">
          <span>{t('Runs on your device · may make mistakes')}</span>
          {usage !== null && <MemoryGauge used={usage} of={contextWindow} />}
        </div>
      </form>

      <SettingsDialog open={settings} initialTab={settingsTab} onClose={() => setSettings(false)} onDeleteAllChats={running ? undefined : deleteAll} />
      {voiceMode && (
        <VoiceMode
          onAsk={(t) => send(t, { speak: true })}
          onStop={() => runningRef.current && stop()}
          onClose={() => setVoiceMode(false)}
          onOpenSettings={() => openSettings('voice')}
          answer={liveAnswer}
        />
      )}
      <AssistantPicker
        open={picker}
        current={assistant.id}
        onClose={() => setPicker(false)}
        onPick={(id) => { setPicker(false); newChat(id === DEFAULT_ASSISTANT.id ? null : id); }}
      />
      <HistoryPanel
        open={history}
        onClose={() => setHistory(false)}
        currentId={chatId}
        busy={running}
        onOpen={openChat}
        onNew={() => newChat()}
      />
    </div>
  );
}

interface VersionsProp { current: number; total: number; onShow(n: number): void }

/** ‹ 2 / 3 ›: earlier answers (regenerated) or questions (edited) of this turn. */
function VersionSwitch({ v, busy }: { v: VersionsProp; busy: boolean }) {
  return (
    <span class="versions" role="group" aria-label={t('Version {n} of {total}', { n: v.current + 1, total: v.total })}>
      <button class="act" disabled={busy || v.current === 0} onClick={() => v.onShow(v.current - 1)} aria-label={t('Previous version')} title={t('Previous version')}>‹</button>
      <span class="versions-n">{v.current + 1} / {v.total}</span>
      <button class="act" disabled={busy || v.current === v.total - 1} onClick={() => v.onShow(v.current + 1)} aria-label={t('Next version')} title={t('Next version')}>›</button>
    </span>
  );
}

function UserMessage({ text, image, busy, onEdit, versions }: { text: string; image?: string; busy: boolean; onEdit(text: string): void; versions?: VersionsProp }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  if (editing) {
    const submit = () => {
      if (!draft.trim() && !image) return;
      setEditing(false);
      onEdit(draft);
    };
    return (
      <div class="msg user editing">
        {image && <img class="msg-image" src={image} alt={t('Attached image')} />}
        <textarea
          value={draft}
          onInput={(ev) => setDraft(ev.currentTarget.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); submit(); }
            if (ev.key === 'Escape') setEditing(false);
          }}
          ref={(el) => el?.focus()}
        />
        <div class="edit-actions">
          <span class="small">{t('The current version stays available with ‹ ›.')}</span>
          <button class="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>{t('Cancel')}</button>
          <button class="btn btn-sm btn-primary" disabled={busy || (!draft.trim() && !image)} onClick={submit}>{t('Send')}</button>
        </div>
      </div>
    );
  }
  return (
    <div class="user-wrap">
      {image && (
        <a href={image} target="_blank" rel="noopener" class="msg-image-link">
          <img class="msg-image" src={image} alt={t('Image you sent')} />
        </a>
      )}
      {text && <div class="msg user">{text}</div>}
      <div class="acts user-acts">
        <CopyButton text={text} />
        <button class="act" disabled={busy} onClick={() => { setDraft(text); setEditing(true); }} aria-label={t('Edit and resend')} title={t('Edit and resend')}>
          <EditIcon />
        </button>
        {versions && <VersionSwitch v={versions} busy={busy} />}
      </div>
    </div>
  );
}

function Entry({ e, versions, speaking, busy, last, onRegenerate, onEdit, onUndoMemory, onManageMemory }: {
  e: ChatEntry;
  /** This turn's versions, shown on its answer (or its question when it has none). */
  versions?: VersionsProp;
  speaking: string | null;
  busy: boolean;
  /** The latest answer: offer to regenerate it. */
  last: boolean;
  onRegenerate(): void;
  onEdit(text: string): void;
  onUndoMemory(): void;
  onManageMemory(): void;
}) {
  if (e.role === 'user') return <UserMessage text={e.text} image={e.image} busy={busy} onEdit={onEdit} versions={versions} />;
  if (e.role === 'memory') {
    return (
      <div class={e.undone ? 'memory-chip undone' : 'memory-chip'}>
        <BrainIcon />
        <span class="memory-text">
          {e.undone
            ? t('Memory not kept')
            : <>{t('Memory updated:')} {e.texts.join(' · ')}{e.replaced?.length ? <span class="muted"> ({t('replaces: {old}', { old: e.replaced.map((m) => m.text).join(' · ') })})</span> : null}</>}
        </span>
        {!e.undone && <button class="link" onClick={onUndoMemory}>{t('Undo')}</button>}
        <button class="link" onClick={onManageMemory}>{t('Manage')}</button>
      </div>
    );
  }
  if (e.role === 'summary') {
    return (
      <details class="summary-row">
        <summary><span>{t('Earlier messages summarized')}</span></summary>
        <p>{e.text}</p>
        <p class="small muted">{t('The AI keeps this summary in mind instead of the older messages, which no longer fit in its memory.')}</p>
      </details>
    );
  }
  if (e.role === 'doc') {
    return (
      <div class="doc-card">
        <span class="doc-icon"><FileIcon /></span>
        <span class="doc-info">
          <strong>{e.name}</strong>
          <span class="muted small">
            {[e.pages && tn(e.pages, '{n} page', '{n} pages'), tn(e.passages, '{n} passage', '{n} passages'), e.semantic ? t('ready to search') : t('keyword search only')].filter(Boolean).join(' · ')}
          </span>
        </span>
      </div>
    );
  }
  if (e.role === 'assistant') {
    const key = String(e.ts);
    const on = speaking === key;
    return (
      <div class="msg assistant">
        {e.thinking && <Thinking text={e.thinking} secs={e.thinkSecs} />}
        <Markdown text={e.text} />
        <div class="meta">
          <button
            class={on ? 'act on' : 'act'}
            onClick={() => speakText(key, e.text)}
            aria-label={on ? t('Stop reading') : t('Read aloud')}
            title={on ? t('Stop') : t('Read aloud')}
          >
            {on ? <StopIcon /> : <SpeakerIcon />}
          </button>
          <CopyButton text={e.text} />
          {last && !e.notice && (
            <button class="act" disabled={busy} onClick={onRegenerate} aria-label={t('Regenerate answer')} title={t('Regenerate')}>
              <RetryIcon />
            </button>
          )}
          {versions && <VersionSwitch v={versions} busy={busy} />}
          <span>{[e.by && t('Answered by {model}', { model: e.by }), e.interrupted && t('Stopped'), e.tps && t('{n} tokens/s', { n: e.tps.toLocaleString(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) })].filter(Boolean).join(' · ')}</span>
        </div>
      </div>
    );
  }
  const args = Object.entries(e.args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
  const def = findTool(e.name);
  const icon = def?.web ? <GlobeIcon /> : <ToolIcon />;
  const cls = e.error ? 'tool tool-error' : 'tool';
  // "Weather · Ghent" rather than weather(location: "Ghent"): the tool's name and its main
  // argument; the exact call stays in the unfolded details.
  const subject = Object.values(e.args).find((v): v is string => typeof v === 'string' && !!v.trim() && v.length <= 80 && !v.includes('\n'));
  const head = (
    <>
      {icon}
      <span class="tool-name">{def?.label ?? e.name.replace(/_/g, ' ')}</span>
      {subject && <span class="tool-args">{subject}</span>}
      <span class="tool-arrow">→</span>
    </>
  );
  const thought = e.thinking && <Thinking text={e.thinking} secs={e.thinkSecs} />;
  if (e.name === 'run_code') return <>{thought}<CodeRun e={e} /></>;
  // Images a tool returned (generate_image, MCP tools): shown under its row.
  const pictures = (e.images ?? []).filter((u) => /^data:image\/(png|jpeg|webp|gif);base64,/.test(u)).map((src, i) => (
    <a href={src} download={`image-${e.ts}-${i + 1}.png`} title={t('Download')}>
      <img class="tool-image" src={src} alt={e.name === 'generate_image' ? (e.args.prompt ?? t('Generated image')) : t('Image from a tool')} />
    </a>
  ));
  // Short results inline; long ones (articles, forecasts) fold to their first line.
  if (e.result.length <= 120 && !e.result.includes('\n')) {
    return <>{thought}<div class={cls}>{head}<span class="tool-result">{e.result}</span></div>{pictures}</>;
  }
  return (
    <>
      {thought}
      <details class={`${cls} tool-long`}>
        <summary>{head}<span class="tool-result tool-preview">{e.result.split('\n')[0]}</span></summary>
        <div class="tool-full"><span class="tool-args">{e.name}({args})</span>{e.result}</div>
      </details>
      {pictures}
    </>
  );
}

/** A run_code call: the code (folded), what it printed, and its charts. */
export function CodeRun({ e }: { e: Extract<ChatEntry, { role: 'tool' }> }) {
  const lang = /^py/i.test(e.args.language ?? '') ? 'python' : 'javascript';
  const code = e.args.code ?? '';
  const lines = code.split('\n').length;
  // Only PNG data URLs from the sandbox (or a backup) are shown.
  const images = (e.images ?? []).filter((u) => u.startsWith('data:image/png;base64,'));
  // What the model read (see runCodeTool), minus the notes meant for it.
  const text = e.result
    .split('\n')
    .filter((l) => !/^\((A chart is|\d+ charts are) shown to the user\.\)$/.test(l) && !l.startsWith('(The code ran without'))
    .join('\n');
  const m = /^(?:…)?(?:Output:\n([\s\S]*?))?(?:\n?Result: ([\s\S]*?))?(?:\n?Error:\n?([\s\S]*))?$/.exec(text.trim());
  const output = m ? [m[1], m[2] !== undefined && `→ ${m[2]}`].filter(Boolean).join('\n').trim() : text.trim();
  const failure = m ? m[3]?.trim() : undefined;
  return (
    <div class="code-run">
      <details>
        <summary><CodeIcon /> {t('Ran {language}', { language: lang === 'python' ? 'Python' : 'JavaScript' })} <span class="muted">· {tn(lines, '{n} line', '{n} lines')}</span></summary>
        <CodeBlock code={code} lang={lang} />
      </details>
      {output && <pre class="code-out">{output}</pre>}
      {failure && <pre class="code-out code-err">{failure}</pre>}
      {images.map((src, i) => (
        <a href={src} download={`chart-${i + 1}.png`} title={t('Download the chart')}>
          <img class="code-chart" src={src} alt={t('Chart drawn by the code')} />
        </a>
      ))}
    </div>
  );
}

/** "Using GitHub: Create issue" for connector tools, "Running x" otherwise. */
function toolStatus(name: string): string {
  const tool = findTool(name);
  return tool?.mcp ? t('Using {server}: {tool}', { server: tool.mcp.server, tool: tool.label }) : t('Running {tool}', { tool: name });
}

const isBlock = (v: unknown) => typeof v === 'string' && (v.length > 120 || v.includes('\n'));

/** A connector wants to do something that may change data: the user decides. */
function ApprovalCard({ req, onAnswer }: { req: ApprovalRequest; onAnswer(a: Approval): void }) {
  const args = Object.entries(req.args);
  return (
    <div class="approval" role="alertdialog" aria-label={t('Allow this action?')}>
      <strong>{t('{server} wants to: {action}', { server: req.server, action: req.tool })}</strong>
      {args.length > 0 && (
        <dl class="kv small">
          {args.filter(([, v]) => !isBlock(v)).map(([k, v]) => <><dt>{k}</dt><dd>{typeof v === 'string' ? v.slice(0, 300) : JSON.stringify(v).slice(0, 300)}</dd></>)}
        </dl>
      )}
      {/* Code and file contents in full: the user is approving exactly this. */}
      {args.filter(([, v]) => isBlock(v)).map(([k, v]) => (
        <div class="approval-block"><span class="small">{k}</span><pre>{String(v)}</pre></div>
      ))}
      <div class="row">
        <button class="btn btn-sm btn-primary" onClick={() => onAnswer('once')}>{t('Allow once')}</button>
        {!req.everyTime && <button class="btn btn-sm" onClick={() => onAnswer('always')}>{t('Always allow')}</button>}
        <button class="btn btn-sm btn-ghost" onClick={() => onAnswer('deny')}>{t('Deny')}</button>
      </div>
    </div>
  );
}

/** How full the model's context window was on the last answer. */
function MemoryGauge({ used, of }: { used: number; of: number }) {
  const share = Math.min(1, used / of);
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  return (
    <span
      class={share > 0.85 ? 'gauge full' : 'gauge'}
      title={t('The last answer used {used} of the {total} tokens this model keeps in mind. When it fills up, older messages are summarized.', { used: used.toLocaleString(locale), total: of.toLocaleString(locale) })}
    >
      <span class="gauge-bar"><span style={{ width: `${Math.max(4, share * 100)}%` }} /></span>
      {k(used)} / {k(of)}
    </span>
  );
}

/**
 * A reasoning model's thoughts: open and following the end while it thinks,
 * then folded to "Thought for 12 s".
 */
function Thinking({ text, secs, live }: { text: string; secs?: number; live?: boolean }) {
  const label = live ? t('Thinking…') : secs !== undefined ? (secs < 1 ? t('Thought for a moment') : t('Thought for {n} s', { n: Math.round(secs) })) : t('Thoughts');
  // While streaming, the tail is what's new; the whole text is there once it's done.
  const shown = live && text.length > 600 ? `…${text.slice(-600)}` : text;
  return (
    <details class={live ? 'think live' : 'think'} open={live}>
      <summary>{live && <span class="dots"><i /><i /><i /></span>}<BulbIcon /> {label}</summary>
      {shown && <div class="think-body">{shown}</div>}
    </details>
  );
}
