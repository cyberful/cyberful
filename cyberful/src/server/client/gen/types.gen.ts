// ── Control-Plane API Types ───────────────────────────────────
// Declares the request, response, error, event, and model types derived from the
// control-plane OpenAPI document consumed by the terminal client.
// → cyberful/script/generate-client.ts — regenerates and patches this module.
// ─────────────────────────────────────────────────────────────────

export type ClientOptions = {
    baseUrl: `${string}://${string}` | (string & {});
};

export type Event = EventTuiPromptAppend | EventTuiCommandExecute | EventTuiToastShow1 | EventTuiSessionSelect | EventServerConnected | EventGlobalDisposed | EventServerInstanceDisposed | EventMessagePartDelta | EventSessionDiff | EventSessionError | EventCommandExecuted | EventFileEdited | EventFileWatcherUpdated | EventProjectUpdated | EventPtyCreated | EventPtyUpdated | EventPtyExited | EventPtyDeleted | EventQuestionAsked | EventQuestionReplied | EventQuestionRejected | EventSessionStatus | EventSessionIdle | EventSessionVariableUpdated | EventTodoUpdated | EventVcsBranchUpdated | EventSessionNextAgentSwitched | EventSessionNextPrompted | EventSessionNextSynthetic | EventSessionNextSkillLearned | EventSessionNextSubsystemPhaseActivity | EventSessionNextShellStarted | EventSessionNextShellEnded | EventSessionNextTextStarted | EventSessionNextTextDelta | EventSessionNextTextEnded | EventSessionNextReasoningStarted | EventSessionNextReasoningDelta | EventSessionNextReasoningEnded | EventSessionNextToolInputStarted | EventSessionNextToolInputDelta | EventSessionNextToolInputEnded | EventSessionNextToolCalled | EventSessionNextToolProgress | EventSessionNextToolSuccess | EventSessionNextToolFailed | EventSessionNextRetried | EventSessionNextCompactionStarted | EventSessionNextCompactionDelta | EventSessionNextCompactionEnded | EventMessageUpdated | EventMessageRemoved | EventMessagePartUpdated | EventMessagePartRemoved | EventSessionCreated | EventSessionUpdated | EventSessionDeleted;

export type EffectHttpApiErrorBadRequest = {
    _tag: 'BadRequest';
};

export type InvalidRequestError = {
    _tag: 'InvalidRequestError';
    message: string;
    kind?: string;
    field?: string;
};

export type EventTuiPromptAppend = {
    id: string;
    type: 'tui.prompt.append';
    properties: {
        text: string;
    };
};

export type EventTuiCommandExecute = {
    id: string;
    type: 'tui.command.execute';
    properties: {
        command: 'session.list' | 'session.new' | 'session.interrupt' | 'session.page.up' | 'session.page.down' | 'session.line.up' | 'session.line.down' | 'session.half.page.up' | 'session.half.page.down' | 'session.first' | 'session.last' | 'prompt.clear' | 'prompt.submit' | 'agent.cycle' | string;
    };
};

export type EventTuiToastShow = {
    id: string;
    type: 'tui.toast.show';
    properties: {
        title?: string;
        message: string;
        variant: 'info' | 'success' | 'warning' | 'error';
        duration?: number;
    };
};

export type EventTuiSessionSelect = {
    id: string;
    type: 'tui.session.select';
    properties: {
        /**
         * Session ID to navigate to
         */
        sessionID: string;
    };
};

export type SnapshotFileDiff = {
    file?: string;
    patch?: string;
    additions: number;
    deletions: number;
    status?: 'added' | 'deleted' | 'modified';
};

export type UnknownError = {
    name: 'UnknownError';
    data: {
        message: string;
        ref?: string;
    };
};

export type MessageAbortedError = {
    name: 'MessageAbortedError';
    data: {
        message: string;
    };
};

export type Project = {
    id: string;
    worktree: string;
    vcs?: 'git';
    name?: string;
    icon?: {
        url?: string;
        override?: string;
        color?: string;
    };
    time: {
        created: number;
        updated: number;
    };
};

export type Pty = {
    id: string;
    title: string;
    command: string;
    args: Array<string>;
    cwd: string;
    status: 'running' | 'exited';
    pid: number;
};

export type QuestionOption = {
    /**
     * Display text (1-5 words, concise)
     */
    label: string;
    /**
     * Explanation of choice
     */
    description: string;
};

export type QuestionInfo = {
    /**
     * Complete question
     */
    question: string;
    /**
     * Very short label (max 30 chars)
     */
    header: string;
    /**
     * Available choices
     */
    options: Array<QuestionOption>;
    multiple?: boolean;
    custom?: boolean;
};

export type QuestionTool = {
    messageID: string;
    callID: string;
};

export type QuestionRequest = {
    id: string;
    sessionID: string;
    /**
     * Questions to ask
     */
    questions: Array<QuestionInfo>;
    tool?: QuestionTool;
};

export type QuestionAnswer = Array<string>;

export type QuestionReplied = {
    sessionID: string;
    requestID: string;
    answers: Array<QuestionAnswer>;
};

export type QuestionRejected = {
    sessionID: string;
    requestID: string;
};

export type SessionStatus = {
    type: 'idle';
} | {
    type: 'busy';
    message?: string;
};

export type SessionVariableName = string;

export type SessionVariableSummary = {
    name: SessionVariableName;
    description?: string;
    type: string;
    size: number | 'NaN' | 'Infinity' | '-Infinity' | 'Infinity' | '-Infinity' | 'NaN';
    preview: string;
};

export type Todo = {
    /**
     * Brief description of the task
     */
    content: string;
    /**
     * Current status of the task: pending, in_progress, completed, cancelled
     */
    status: string;
    /**
     * Priority level of the task: high, medium, low
     */
    priority: string;
};

export type Prompt = {
    text: string;
    files?: Array<PromptFileAttachment>;
    references?: Array<PromptReferenceAttachment>;
};

export type UserMessage = {
    id: string;
    sessionID: string;
    role: 'user';
    time: {
        created: number;
    };
    summary?: {
        title?: string;
        body?: string;
        diffs: Array<SnapshotFileDiff>;
    };
    agent: string;
    model: {
        providerID: string;
        modelID: string;
        variant?: string;
    };
    system?: string;
    tools?: {
        [key: string]: boolean;
    };
    metadata?: {
        [key: string]: unknown;
    };
};

export type AssistantMessage = {
    id: string;
    sessionID: string;
    role: 'assistant';
    time: {
        created: number;
        completed?: number;
    };
    error?: UnknownError | MessageAbortedError;
    parentID: string;
    modelID: string;
    providerID: string;
    mode: string;
    agent: string;
    path: {
        cwd: string;
        root: string;
    };
    summary?: boolean;
    tokens: {
        total?: number;
        input: number;
        output: number;
        reasoning: number;
        cache: {
            read: number;
            write: number;
        };
    };
    structured?: unknown;
    variant?: string;
    finish?: string;
    steps?: {
        current: number;
        budget: number;
    };
};

export type Message = UserMessage | AssistantMessage;

export type TextPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'text';
    text: string;
    synthetic?: boolean;
    ignored?: boolean;
    time?: {
        start: number;
        end?: number;
    };
    metadata?: {
        [key: string]: unknown;
    };
};

export type CompletionArtifact = {
    label: string;
    path: string;
    mime: string;
    primary?: boolean;
};

export type CompletionPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'completion';
    workflow: string;
    outcome: 'success' | 'warning' | 'blocked' | 'failed';
    title: string;
    summaryMarkdown: string;
    workarea?: string;
    artifacts: Array<CompletionArtifact>;
    nextWorkflow?: string;
};

export type SubtaskPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'subtask';
    prompt: string;
    description: string;
    agent: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    command?: string;
};

export type ReasoningPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'reasoning';
    text: string;
    metadata?: {
        [key: string]: unknown;
    };
    time: {
        start: number;
        end?: number;
    };
};

export type FilePartSourceText = {
    value: string;
    start: number;
    end: number;
};

export type FileSource = {
    text: FilePartSourceText;
    type: 'file';
    path: string;
};

export type Range = {
    start: {
        line: number;
        character: number;
    };
    end: {
        line: number;
        character: number;
    };
};

export type SymbolSource = {
    text: FilePartSourceText;
    type: 'symbol';
    path: string;
    range: Range;
    name: string;
    kind: number;
};

export type FilePartSource = FileSource | SymbolSource;

export type FilePart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'file';
    mime: string;
    filename?: string;
    url: string;
    source?: FilePartSource;
};

export type ToolStatePending = {
    status: 'pending';
    input: {
        [key: string]: unknown;
    };
    raw: string;
};

export type ToolStateRunning = {
    status: 'running';
    input: {
        [key: string]: unknown;
    };
    title?: string;
    metadata?: {
        [key: string]: unknown;
    };
    time: {
        start: number;
    };
};

export type ToolStateCompleted = {
    status: 'completed';
    input: {
        [key: string]: unknown;
    };
    output: string;
    title: string;
    metadata: {
        [key: string]: unknown;
    };
    time: {
        start: number;
        end: number;
        compacted?: number;
    };
    attachments?: Array<FilePart>;
};

export type ToolStateError = {
    status: 'error';
    input: {
        [key: string]: unknown;
    };
    error: string;
    metadata?: {
        [key: string]: unknown;
    };
    time: {
        start: number;
        end: number;
    };
};

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

export type ToolPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'tool';
    callID: string;
    tool: string;
    state: ToolState;
    metadata?: {
        [key: string]: unknown;
    };
};

export type StepStartPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'step-start';
    snapshot?: string;
};

export type StepFinishPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'step-finish';
    reason: string;
    snapshot?: string;
    tokens: {
        total?: number;
        input: number;
        output: number;
        reasoning: number;
        cache: {
            read: number;
            write: number;
        };
    };
};

export type SnapshotPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'snapshot';
    snapshot: string;
};

export type PatchPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'patch';
    hash: string;
    files: Array<string>;
};

export type AgentPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'agent';
    name: string;
    source?: {
        value: string;
        start: number;
        end: number;
    };
};

export type CompactionPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: 'compaction';
    auto: boolean;
    overflow?: boolean;
    tail_start_id?: string;
};

export type Part = TextPart | CompletionPart | SubtaskPart | ReasoningPart | FilePart | ToolPart | StepStartPart | StepFinishPart | SnapshotPart | PatchPart | AgentPart | CompactionPart;

export type Session = {
    id: string;
    slug: string;
    projectID: string;
    directory: string;
    path?: string;
    parentID?: string;
    summary?: {
        additions: number;
        deletions: number;
        files: number;
        diffs?: Array<SnapshotFileDiff>;
    };
    tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache: {
            read: number;
            write: number;
        };
    };
    title: string;
    workflow?: string;
    agent?: string;
    model?: {
        id: string;
        providerID: string;
        variant?: string;
    };
    version: string;
    time: {
        created: number;
        updated: number;
        compacting?: number;
        archived?: number;
    };
    revert?: {
        messageID: string;
        partID?: string;
        snapshot?: string;
        diff?: string;
    };
};

export type GlobalEvent = {
    directory: string;
    project?: string;
    payload: EventTuiPromptAppend | EventTuiCommandExecute | EventTuiToastShow | EventTuiSessionSelect | EventServerConnected | EventGlobalDisposed | EventServerInstanceDisposed | EventMessagePartDelta | EventSessionDiff | EventSessionError | EventCommandExecuted | EventFileEdited | EventFileWatcherUpdated | EventProjectUpdated | EventPtyCreated | EventPtyUpdated | EventPtyExited | EventPtyDeleted | EventQuestionAsked | EventQuestionReplied | EventQuestionRejected | EventSessionStatus | EventSessionIdle | EventSessionVariableUpdated | EventTodoUpdated | EventVcsBranchUpdated | EventSessionNextAgentSwitched | EventSessionNextPrompted | EventSessionNextSynthetic | EventSessionNextSkillLearned | EventSessionNextSubsystemPhaseActivity | EventSessionNextShellStarted | EventSessionNextShellEnded | EventSessionNextTextStarted | EventSessionNextTextDelta | EventSessionNextTextEnded | EventSessionNextReasoningStarted | EventSessionNextReasoningDelta | EventSessionNextReasoningEnded | EventSessionNextToolInputStarted | EventSessionNextToolInputDelta | EventSessionNextToolInputEnded | EventSessionNextToolCalled | EventSessionNextToolProgress | EventSessionNextToolSuccess | EventSessionNextToolFailed | EventSessionNextRetried | EventSessionNextCompactionStarted | EventSessionNextCompactionDelta | EventSessionNextCompactionEnded | EventMessageUpdated | EventMessageRemoved | EventMessagePartUpdated | EventMessagePartRemoved | EventSessionCreated | EventSessionUpdated | EventSessionDeleted | SyncEventMessageUpdated | SyncEventMessageRemoved | SyncEventMessagePartUpdated | SyncEventMessagePartRemoved | SyncEventSessionCreated | SyncEventSessionUpdated | SyncEventSessionDeleted | SyncEventSessionNextAgentSwitched | SyncEventSessionNextPrompted | SyncEventSessionNextSynthetic | SyncEventSessionNextShellStarted | SyncEventSessionNextShellEnded | SyncEventSessionNextTextStarted | SyncEventSessionNextTextDelta | SyncEventSessionNextTextEnded | SyncEventSessionNextReasoningStarted | SyncEventSessionNextReasoningDelta | SyncEventSessionNextReasoningEnded | SyncEventSessionNextToolInputStarted | SyncEventSessionNextToolInputDelta | SyncEventSessionNextToolInputEnded | SyncEventSessionNextToolCalled | SyncEventSessionNextToolProgress | SyncEventSessionNextToolSuccess | SyncEventSessionNextToolFailed | SyncEventSessionNextRetried | SyncEventSessionNextCompactionStarted | SyncEventSessionNextCompactionDelta | SyncEventSessionNextCompactionEnded;
};

/**
 * Log level
 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export type ReferenceConfigEntry = string | {
    /**
     * Git repository URL, host/path reference, or GitHub owner/repo shorthand
     */
    repository: string;
    branch?: string;
} | {
    /**
     * Absolute path, ~/ path, or workspace-relative path to a local reference directory
     */
    path: string;
};

export type ReferenceConfig = {
    [key: string]: ReferenceConfigEntry;
};

export type AgentConfig = {
    name: string;
    workflow?: string;
    prompt?: string;
    description?: string;
    hidden?: boolean;
    color?: string | 'primary' | 'secondary' | 'accent' | 'success' | 'warning' | 'error' | 'info';
    subagents?: number;
    [key: string]: unknown | string | boolean | string | 'primary' | 'secondary' | 'accent' | 'success' | 'warning' | 'error' | 'info' | number | undefined;
};

export type Config = {
    $schema?: string;
    shell?: string;
    logLevel?: LogLevel;
    command?: {
        [key: string]: {
            template: string;
            description?: string;
            agent?: string;
            subtask?: boolean;
        };
    };
    skills?: {
        paths?: Array<string>;
    };
    reference?: ReferenceConfig;
    watcher?: {
        ignore?: Array<string>;
    };
    snapshot?: boolean;
    default_agent?: string;
    username?: string;
    agent?: {
        [key: string]: AgentConfig;
    };
    /**
     * Enable or configure formatters. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.
     */
    formatter?: boolean | {
        [key: string]: {
            disabled?: boolean;
            command?: Array<string>;
            environment?: {
                [key: string]: string;
            };
            extensions?: Array<string>;
        };
    };
    tool_output?: {
        max_lines?: number;
        max_bytes?: number;
    };
    experimental?: {
        disable_paste_summary?: boolean;
    };
};

export type FileNode = {
    name: string;
    path: string;
    absolute: string;
    type: 'file' | 'directory';
    ignored: boolean;
};

export type FileContent = {
    type: 'text' | 'binary';
    content: string;
    diff?: string;
    patch?: {
        oldFileName: string;
        newFileName: string;
        oldHeader?: string;
        newHeader?: string;
        hunks: Array<{
            oldStart: number;
            oldLines: number;
            newStart: number;
            newLines: number;
            lines: Array<string>;
        }>;
        index?: string;
    };
    encoding?: 'base64';
    mimeType?: string;
};

export type File = {
    path: string;
    added: number;
    removed: number;
    status: 'added' | 'deleted' | 'modified';
};

export type Path = {
    home: string;
    state: string;
    config: string;
    worktree: string;
    directory: string;
};

export type VcsInfo = {
    branch?: string;
    default_branch?: string;
};

export type VcsFileStatus = {
    file: string;
    additions: number;
    deletions: number;
    status: 'added' | 'deleted' | 'modified';
};

export type VcsFileDiff = {
    file: string;
    patch?: string;
    additions: number;
    deletions: number;
    status?: 'added' | 'deleted' | 'modified';
};

export type VcsApplyError = {
    name: 'VcsApplyError';
    data: {
        message: string;
        reason: 'non-git' | 'not-clean';
    };
};

export type Command = {
    name: string;
    description?: string;
    agent?: string;
    source?: 'command' | 'skill';
    template: string;
    subtask?: boolean;
    hints: Array<string>;
};

export type Agent = {
    name: string;
    workflow?: string;
    description?: string;
    mode: 'primary';
    hidden?: boolean;
    color?: string;
    prompt?: string;
};

export type FormatterStatus = {
    name: string;
    extensions: Array<string>;
    enabled: boolean;
};

export type RuntimeStatus = {
    primary: {
        name: string;
        model: string;
        version?: string;
        status: 'available' | 'degraded' | 'unavailable';
    };
    fallback: {
        model?: string;
        status: 'available' | 'disabled' | 'unavailable';
    };
};

export type ProjectNotFoundError = {
    _tag: 'ProjectNotFoundError';
    projectID: string;
    message: string;
};

export type PtyNotFoundError = {
    _tag: 'PtyNotFoundError';
    ptyID: string;
    message: string;
};

export type PtyForbiddenError = {
    _tag: 'PtyForbiddenError';
    message: string;
};

export type QuestionNotFoundError = {
    _tag: 'QuestionNotFoundError';
    requestID: string;
    message: string;
};

export type NotFoundError = {
    name: 'NotFoundError';
    data: {
        message: string;
    };
};

export type TextPartInput = {
    id?: string;
    type: 'text';
    text: string;
    synthetic?: boolean;
    ignored?: boolean;
    time?: {
        start: number;
        end?: number;
    };
    metadata?: {
        [key: string]: unknown;
    };
};

export type FilePartInput = {
    id?: string;
    type: 'file';
    mime: string;
    filename?: string;
    url: string;
    source?: FilePartSource;
};

export type SessionBusyError = {
    _tag: 'SessionBusyError';
    sessionID: string;
    message: string;
};

export type EventTuiPromptAppend2 = {
    type: 'tui.prompt.append';
    properties: {
        text: string;
    };
};

export type EventTuiCommandExecute2 = {
    type: 'tui.command.execute';
    properties: {
        command: 'session.list' | 'session.new' | 'session.interrupt' | 'session.page.up' | 'session.page.down' | 'session.line.up' | 'session.line.down' | 'session.half.page.up' | 'session.half.page.down' | 'session.first' | 'session.last' | 'prompt.clear' | 'prompt.submit' | 'agent.cycle' | string;
    };
};

export type EventTuiToastShow2 = {
    type: 'tui.toast.show';
    properties: {
        title?: string;
        message: string;
        variant: 'info' | 'success' | 'warning' | 'error';
        duration?: number;
    };
};

export type EventTuiSessionSelect2 = {
    type: 'tui.session.select';
    properties: {
        /**
         * Session ID to navigate to
         */
        sessionID: string;
    };
};

export type EffectHttpApiErrorForbidden = {
    _tag: 'Forbidden';
};

export type SessionVariableSummary1 = {
    name: SessionVariableName;
    description?: string;
    type: string;
    size: number | 'NaN' | 'Infinity' | '-Infinity';
    preview: string;
};

export type SyncEventMessageUpdated = {
    type: 'sync';
    name: 'message.updated.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        sessionID: string;
        info: Message;
    };
};

export type SyncEventMessageRemoved = {
    type: 'sync';
    name: 'message.removed.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        sessionID: string;
        messageID: string;
    };
};

export type SyncEventMessagePartUpdated = {
    type: 'sync';
    name: 'message.part.updated.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        sessionID: string;
        part: Part;
        time: number;
    };
};

export type SyncEventMessagePartRemoved = {
    type: 'sync';
    name: 'message.part.removed.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        sessionID: string;
        messageID: string;
        partID: string;
    };
};

export type SyncEventSessionCreated = {
    type: 'sync';
    name: 'session.created.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        sessionID: string;
        info: Session;
    };
};

export type SyncEventSessionUpdated = {
    type: 'sync';
    name: 'session.updated.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        sessionID: string;
        info: {
            id?: string | null;
            slug?: string | null;
            projectID?: string | null;
            directory?: string | null;
            path?: string | null;
            parentID?: string | null;
            summary?: {
                additions: number;
                deletions: number;
                files: number;
                diffs?: Array<SnapshotFileDiff>;
            } | null;
            tokens?: {
                input: number;
                output: number;
                reasoning: number;
                cache: {
                    read: number;
                    write: number;
                };
            } | null;
            title?: string | null;
            workflow?: string | null;
            agent?: string | null;
            model?: {
                id: string;
                providerID: string;
                variant?: string;
            } | null;
            version?: string | null;
            time?: {
                created?: number | null;
                updated?: number | null;
                compacting?: number | null;
                archived?: number | null;
            };
            revert?: {
                messageID: string;
                partID?: string;
                snapshot?: string;
                diff?: string;
            } | null;
        };
    };
};

export type SyncEventSessionDeleted = {
    type: 'sync';
    name: 'session.deleted.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        sessionID: string;
        info: Session;
    };
};

export type SyncEventSessionNextAgentSwitched = {
    type: 'sync';
    name: 'session.next.agent.switched.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        agent: string;
    };
};

export type SyncEventSessionNextPrompted = {
    type: 'sync';
    name: 'session.next.prompted.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        prompt: Prompt;
    };
};

export type SyncEventSessionNextSynthetic = {
    type: 'sync';
    name: 'session.next.synthetic.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        text: string;
    };
};

export type SyncEventSessionNextShellStarted = {
    type: 'sync';
    name: 'session.next.shell.started.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        callID: string;
        command: string;
    };
};

export type SyncEventSessionNextShellEnded = {
    type: 'sync';
    name: 'session.next.shell.ended.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        callID: string;
        output: string;
    };
};

export type SyncEventSessionNextTextStarted = {
    type: 'sync';
    name: 'session.next.text.started.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
    };
};

export type SyncEventSessionNextTextDelta = {
    type: 'sync';
    name: 'session.next.text.delta.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        delta: string;
    };
};

export type SyncEventSessionNextTextEnded = {
    type: 'sync';
    name: 'session.next.text.ended.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        text: string;
    };
};

export type SyncEventSessionNextReasoningStarted = {
    type: 'sync';
    name: 'session.next.reasoning.started.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        reasoningID: string;
    };
};

export type SyncEventSessionNextReasoningDelta = {
    type: 'sync';
    name: 'session.next.reasoning.delta.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        reasoningID: string;
        delta: string;
    };
};

export type SyncEventSessionNextReasoningEnded = {
    type: 'sync';
    name: 'session.next.reasoning.ended.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        reasoningID: string;
        text: string;
    };
};

export type SyncEventSessionNextToolInputStarted = {
    type: 'sync';
    name: 'session.next.tool.input.started.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        callID: string;
        name: string;
    };
};

export type SyncEventSessionNextToolInputDelta = {
    type: 'sync';
    name: 'session.next.tool.input.delta.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        callID: string;
        delta: string;
    };
};

export type SyncEventSessionNextToolInputEnded = {
    type: 'sync';
    name: 'session.next.tool.input.ended.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        callID: string;
        text: string;
    };
};

export type SyncEventSessionNextToolCalled = {
    type: 'sync';
    name: 'session.next.tool.called.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        callID: string;
        tool: string;
        input: {
            [key: string]: unknown;
        };
        provider: {
            executed: boolean;
            metadata?: {
                [key: string]: unknown;
            };
        };
    };
};

export type SyncEventSessionNextToolProgress = {
    type: 'sync';
    name: 'session.next.tool.progress.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        callID: string;
        structured: {
            [key: string]: unknown;
        };
        content: Array<ToolTextContent | ToolFileContent>;
    };
};

export type SyncEventSessionNextToolSuccess = {
    type: 'sync';
    name: 'session.next.tool.success.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        callID: string;
        structured: {
            [key: string]: unknown;
        };
        content: Array<ToolTextContent | ToolFileContent>;
        provider: {
            executed: boolean;
            metadata?: {
                [key: string]: unknown;
            };
        };
    };
};

export type SyncEventSessionNextToolFailed = {
    type: 'sync';
    name: 'session.next.tool.failed.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        callID: string;
        error: SessionErrorUnknown;
        provider: {
            executed: boolean;
            metadata?: {
                [key: string]: unknown;
            };
        };
    };
};

export type SyncEventSessionNextRetried = {
    type: 'sync';
    name: 'session.next.retried.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        attempt: number;
        error: SessionNextRetryError;
    };
};

export type SyncEventSessionNextCompactionStarted = {
    type: 'sync';
    name: 'session.next.compaction.started.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        reason: 'auto' | 'manual';
    };
};

export type SyncEventSessionNextCompactionDelta = {
    type: 'sync';
    name: 'session.next.compaction.delta.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        text: string;
    };
};

export type SyncEventSessionNextCompactionEnded = {
    type: 'sync';
    name: 'session.next.compaction.ended.1';
    id: string;
    seq: number;
    aggregateID: 'sessionID';
    data: {
        timestamp: number;
        sessionID: string;
        text: string;
        include?: string;
    };
};

export type EventServerConnected = {
    id: string;
    type: 'server.connected';
    properties: {
        [key: string]: unknown;
    };
};

export type EventGlobalDisposed = {
    id: string;
    type: 'global.disposed';
    properties: {
        [key: string]: unknown;
    };
};

export type EventServerInstanceDisposed = {
    id: string;
    type: 'server.instance.disposed';
    properties: {
        directory: string;
    };
};

export type EventMessagePartDelta = {
    id: string;
    type: 'message.part.delta';
    properties: {
        sessionID: string;
        messageID: string;
        partID: string;
        field: string;
        delta: string;
        mode?: 'append' | 'replace';
    };
};

export type EventSessionDiff = {
    id: string;
    type: 'session.diff';
    properties: {
        sessionID: string;
        diff: Array<SnapshotFileDiff>;
    };
};

export type EventSessionError = {
    id: string;
    type: 'session.error';
    properties: {
        sessionID?: string;
        error?: UnknownError | MessageAbortedError;
    };
};

export type EventCommandExecuted = {
    id: string;
    type: 'command.executed';
    properties: {
        name: string;
        sessionID: string;
        arguments: string;
        messageID: string;
    };
};

export type EventFileEdited = {
    id: string;
    type: 'file.edited';
    properties: {
        file: string;
    };
};

export type EventFileWatcherUpdated = {
    id: string;
    type: 'file.watcher.updated';
    properties: {
        file: string;
        event: 'add' | 'change' | 'unlink';
    };
};

export type EventProjectUpdated = {
    id: string;
    type: 'project.updated';
    properties: Project;
};

export type EventPtyCreated = {
    id: string;
    type: 'pty.created';
    properties: {
        info: Pty;
    };
};

export type EventPtyUpdated = {
    id: string;
    type: 'pty.updated';
    properties: {
        info: Pty;
    };
};

export type EventPtyExited = {
    id: string;
    type: 'pty.exited';
    properties: {
        id: string;
        exitCode: number;
    };
};

export type EventPtyDeleted = {
    id: string;
    type: 'pty.deleted';
    properties: {
        id: string;
    };
};

export type EventQuestionAsked = {
    id: string;
    type: 'question.asked';
    properties: QuestionRequest;
};

export type EventQuestionReplied = {
    id: string;
    type: 'question.replied';
    properties: QuestionReplied;
};

export type EventQuestionRejected = {
    id: string;
    type: 'question.rejected';
    properties: QuestionRejected;
};

export type EventSessionStatus = {
    id: string;
    type: 'session.status';
    properties: {
        sessionID: string;
        status: SessionStatus;
    };
};

export type EventSessionIdle = {
    id: string;
    type: 'session.idle';
    properties: {
        sessionID: string;
    };
};

export type EventSessionVariableUpdated = {
    id: string;
    type: 'session.variable.updated';
    properties: {
        sessionID: string;
        variables: Array<SessionVariableSummary>;
    };
};

export type EventTodoUpdated = {
    id: string;
    type: 'todo.updated';
    properties: {
        sessionID: string;
        todos: Array<Todo>;
    };
};

export type EventVcsBranchUpdated = {
    id: string;
    type: 'vcs.branch.updated';
    properties: {
        branch?: string;
    };
};

export type EventSessionNextAgentSwitched = {
    id: string;
    type: 'session.next.agent.switched';
    properties: {
        timestamp: number;
        sessionID: string;
        agent: string;
    };
};

export type PromptSource = {
    start: number;
    end: number;
    text: string;
};

export type PromptFileAttachment = {
    uri: string;
    mime: string;
    name?: string;
    description?: string;
    source?: PromptSource;
};

export type PromptReferenceAttachment = {
    name: string;
    kind: 'local' | 'git' | 'invalid';
    uri?: string;
    repository?: string;
    branch?: string;
    target?: string;
    targetUri?: string;
    problem?: string;
    source?: PromptSource;
};

export type EventSessionNextPrompted = {
    id: string;
    type: 'session.next.prompted';
    properties: {
        timestamp: number;
        sessionID: string;
        prompt: Prompt;
    };
};

export type EventSessionNextSynthetic = {
    id: string;
    type: 'session.next.synthetic';
    properties: {
        timestamp: number;
        sessionID: string;
        text: string;
    };
};

export type EventSessionNextSkillLearned = {
    id: string;
    type: 'session.next.skill.learned';
    properties: {
        timestamp: number;
        sessionID: string;
        skills: Array<string>;
    };
};

export type SessionSubsystemDescriptor = {
    name: string;
    version: string;
    label: string;
};

export type SessionPhaseActivityActor = {
    id: string;
    label?: string;
    parentID?: string;
};

export type EventSessionNextSubsystemPhaseActivity = {
    id: string;
    type: 'session.next.subsystem.phase_activity';
    properties: {
        timestamp: number;
        sessionID: string;
        phase: string;
        subsystem: SessionSubsystemDescriptor;
        kind: string;
        text: string;
        tool: string;
        actor?: SessionPhaseActivityActor;
        actorState?: 'started' | 'active' | 'interacted' | 'completed' | 'interrupted' | 'failed';
        actorTransitionID?: string;
    };
};

export type EventSessionNextShellStarted = {
    id: string;
    type: 'session.next.shell.started';
    properties: {
        timestamp: number;
        sessionID: string;
        callID: string;
        command: string;
    };
};

export type EventSessionNextShellEnded = {
    id: string;
    type: 'session.next.shell.ended';
    properties: {
        timestamp: number;
        sessionID: string;
        callID: string;
        output: string;
    };
};

export type EventSessionNextTextStarted = {
    id: string;
    type: 'session.next.text.started';
    properties: {
        timestamp: number;
        sessionID: string;
    };
};

export type EventSessionNextTextDelta = {
    id: string;
    type: 'session.next.text.delta';
    properties: {
        timestamp: number;
        sessionID: string;
        delta: string;
    };
};

export type EventSessionNextTextEnded = {
    id: string;
    type: 'session.next.text.ended';
    properties: {
        timestamp: number;
        sessionID: string;
        text: string;
    };
};

export type EventSessionNextReasoningStarted = {
    id: string;
    type: 'session.next.reasoning.started';
    properties: {
        timestamp: number;
        sessionID: string;
        reasoningID: string;
    };
};

export type EventSessionNextReasoningDelta = {
    id: string;
    type: 'session.next.reasoning.delta';
    properties: {
        timestamp: number;
        sessionID: string;
        reasoningID: string;
        delta: string;
    };
};

export type EventSessionNextReasoningEnded = {
    id: string;
    type: 'session.next.reasoning.ended';
    properties: {
        timestamp: number;
        sessionID: string;
        reasoningID: string;
        text: string;
    };
};

export type EventSessionNextToolInputStarted = {
    id: string;
    type: 'session.next.tool.input.started';
    properties: {
        timestamp: number;
        sessionID: string;
        callID: string;
        name: string;
    };
};

export type EventSessionNextToolInputDelta = {
    id: string;
    type: 'session.next.tool.input.delta';
    properties: {
        timestamp: number;
        sessionID: string;
        callID: string;
        delta: string;
    };
};

export type EventSessionNextToolInputEnded = {
    id: string;
    type: 'session.next.tool.input.ended';
    properties: {
        timestamp: number;
        sessionID: string;
        callID: string;
        text: string;
    };
};

export type EventSessionNextToolCalled = {
    id: string;
    type: 'session.next.tool.called';
    properties: {
        timestamp: number;
        sessionID: string;
        callID: string;
        tool: string;
        input: {
            [key: string]: unknown;
        };
        provider: {
            executed: boolean;
            metadata?: {
                [key: string]: unknown;
            };
        };
    };
};

export type ToolTextContent = {
    type: 'text';
    text: string;
};

export type ToolFileContent = {
    type: 'file';
    uri: string;
    mime: string;
    name?: string;
};

export type EventSessionNextToolProgress = {
    id: string;
    type: 'session.next.tool.progress';
    properties: {
        timestamp: number;
        sessionID: string;
        callID: string;
        structured: {
            [key: string]: unknown;
        };
        content: Array<ToolTextContent | ToolFileContent>;
    };
};

export type EventSessionNextToolSuccess = {
    id: string;
    type: 'session.next.tool.success';
    properties: {
        timestamp: number;
        sessionID: string;
        callID: string;
        structured: {
            [key: string]: unknown;
        };
        content: Array<ToolTextContent | ToolFileContent>;
        provider: {
            executed: boolean;
            metadata?: {
                [key: string]: unknown;
            };
        };
    };
};

export type SessionErrorUnknown = {
    type: 'unknown';
    message: string;
};

export type EventSessionNextToolFailed = {
    id: string;
    type: 'session.next.tool.failed';
    properties: {
        timestamp: number;
        sessionID: string;
        callID: string;
        error: SessionErrorUnknown;
        provider: {
            executed: boolean;
            metadata?: {
                [key: string]: unknown;
            };
        };
    };
};

export type SessionNextRetryError = {
    message: string;
    statusCode?: number;
    isRetryable: boolean;
    responseHeaders?: {
        [key: string]: string;
    };
    responseBody?: string;
    metadata?: {
        [key: string]: string;
    };
};

export type EventSessionNextRetried = {
    id: string;
    type: 'session.next.retried';
    properties: {
        timestamp: number;
        sessionID: string;
        attempt: number;
        error: SessionNextRetryError;
    };
};

export type EventSessionNextCompactionStarted = {
    id: string;
    type: 'session.next.compaction.started';
    properties: {
        timestamp: number;
        sessionID: string;
        reason: 'auto' | 'manual';
    };
};

export type EventSessionNextCompactionDelta = {
    id: string;
    type: 'session.next.compaction.delta';
    properties: {
        timestamp: number;
        sessionID: string;
        text: string;
    };
};

export type EventSessionNextCompactionEnded = {
    id: string;
    type: 'session.next.compaction.ended';
    properties: {
        timestamp: number;
        sessionID: string;
        text: string;
        include?: string;
    };
};

export type EventMessageUpdated = {
    id: string;
    type: 'message.updated';
    properties: {
        sessionID: string;
        info: Message;
    };
};

export type EventMessageRemoved = {
    id: string;
    type: 'message.removed';
    properties: {
        sessionID: string;
        messageID: string;
    };
};

export type EventMessagePartUpdated = {
    id: string;
    type: 'message.part.updated';
    properties: {
        sessionID: string;
        part: Part;
        time: number;
    };
};

export type EventMessagePartRemoved = {
    id: string;
    type: 'message.part.removed';
    properties: {
        sessionID: string;
        messageID: string;
        partID: string;
    };
};

export type EventSessionCreated = {
    id: string;
    type: 'session.created';
    properties: {
        sessionID: string;
        info: Session;
    };
};

export type EventSessionUpdated = {
    id: string;
    type: 'session.updated';
    properties: {
        sessionID: string;
        info: Session;
    };
};

export type EventSessionDeleted = {
    id: string;
    type: 'session.deleted';
    properties: {
        sessionID: string;
        info: Session;
    };
};

export type SessionDelivery = 'immediate' | 'deferred';

export type EventTuiToastShow1 = {
    id: string;
    type: 'tui.toast.show';
    properties: {
        title?: string;
        message: string;
        variant: 'info' | 'success' | 'warning' | 'error';
        duration?: number;
    };
};

export type BadRequestError = {
    name: 'BadRequest';
    data: {
        message: string;
        kind?: 'Params' | 'Headers' | 'Query' | 'Body' | 'Payload';
    };
};

export type AppLogData = {
    body?: {
        /**
         * Service name for the log entry
         */
        service: string;
        /**
         * Log level
         */
        level: 'debug' | 'info' | 'error' | 'warn';
        /**
         * Log message
         */
        message: string;
        extra?: {
            [key: string]: unknown;
        };
    };
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/log';
};

export type AppLogErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
};

export type AppLogError = AppLogErrors[keyof AppLogErrors];

export type AppLogResponses = {
    /**
     * Log entry written successfully
     */
    200: boolean;
};

export type AppLogResponse = AppLogResponses[keyof AppLogResponses];

export type GlobalHealthData = {
    body?: never;
    path?: never;
    query?: never;
    url: '/global/health';
};

export type GlobalHealthErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type GlobalHealthError = GlobalHealthErrors[keyof GlobalHealthErrors];

export type GlobalHealthResponses = {
    /**
     * Health information
     */
    200: {
        healthy: true;
        version: string;
        buildID: string;
        runID: string;
        pid: number;
        startedAt: number;
    };
};

export type GlobalHealthResponse = GlobalHealthResponses[keyof GlobalHealthResponses];

export type GlobalEventData = {
    body?: never;
    path?: never;
    query?: never;
    url: '/global/event';
};

export type GlobalEventErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type GlobalEventError = GlobalEventErrors[keyof GlobalEventErrors];

export type GlobalEventResponses = {
    /**
     * Event stream
     */
    200: GlobalEvent;
};

export type GlobalEventResponse = GlobalEventResponses[keyof GlobalEventResponses];

export type GlobalConfigGetData = {
    body?: never;
    path?: never;
    query?: never;
    url: '/global/config';
};

export type GlobalConfigGetErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type GlobalConfigGetError = GlobalConfigGetErrors[keyof GlobalConfigGetErrors];

export type GlobalConfigGetResponses = {
    /**
     * Get global config info
     */
    200: Config;
};

export type GlobalConfigGetResponse = GlobalConfigGetResponses[keyof GlobalConfigGetResponses];

export type GlobalConfigUpdateData = {
    body?: Config;
    path?: never;
    query?: never;
    url: '/global/config';
};

export type GlobalConfigUpdateErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
};

export type GlobalConfigUpdateError = GlobalConfigUpdateErrors[keyof GlobalConfigUpdateErrors];

export type GlobalConfigUpdateResponses = {
    /**
     * Successfully updated global config
     */
    200: Config;
};

export type GlobalConfigUpdateResponse = GlobalConfigUpdateResponses[keyof GlobalConfigUpdateResponses];

export type GlobalDisposeData = {
    body?: never;
    path?: never;
    query?: never;
    url: '/global/dispose';
};

export type GlobalDisposeErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type GlobalDisposeError = GlobalDisposeErrors[keyof GlobalDisposeErrors];

export type GlobalDisposeResponses = {
    /**
     * Global disposed
     */
    200: boolean;
};

export type GlobalDisposeResponse = GlobalDisposeResponses[keyof GlobalDisposeResponses];

export type EventSubscribeData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/event';
};

export type EventSubscribeResponses = {
    /**
     * Event stream
     */
    200: Event;
};

export type EventSubscribeResponse = EventSubscribeResponses[keyof EventSubscribeResponses];

export type ConfigGetData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/config';
};

export type ConfigGetErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type ConfigGetError = ConfigGetErrors[keyof ConfigGetErrors];

export type ConfigGetResponses = {
    /**
     * Get config info
     */
    200: Config;
};

export type ConfigGetResponse = ConfigGetResponses[keyof ConfigGetResponses];

export type ConfigUpdateData = {
    body?: Config;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/config';
};

export type ConfigUpdateErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
};

export type ConfigUpdateError = ConfigUpdateErrors[keyof ConfigUpdateErrors];

export type ConfigUpdateResponses = {
    /**
     * Successfully updated config
     */
    200: Config;
};

export type ConfigUpdateResponse = ConfigUpdateResponses[keyof ConfigUpdateResponses];

export type FindTextData = {
    body?: never;
    path?: never;
    query: {
        directory?: string;
        pattern: string;
    };
    url: '/find';
};

export type FindTextErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type FindTextError = FindTextErrors[keyof FindTextErrors];

export type FindTextResponses = {
    /**
     * Matches
     */
    200: Array<{
        path: {
            text: string;
        };
        lines: {
            text: string;
        };
        line_number: number;
        absolute_offset: number;
        submatches: Array<{
            match: {
                text: string;
            };
            start: number;
            end: number;
        }>;
    }>;
};

export type FindTextResponse = FindTextResponses[keyof FindTextResponses];

export type FindFilesData = {
    body?: never;
    path?: never;
    query: {
        directory?: string;
        query: string;
        dirs?: 'true' | 'false';
        type?: 'file' | 'directory';
        limit?: number;
    };
    url: '/find/file';
};

export type FindFilesErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type FindFilesError = FindFilesErrors[keyof FindFilesErrors];

export type FindFilesResponses = {
    /**
     * File paths
     */
    200: Array<string>;
};

export type FindFilesResponse = FindFilesResponses[keyof FindFilesResponses];

export type FileListData = {
    body?: never;
    path?: never;
    query: {
        directory?: string;
        path: string;
    };
    url: '/file';
};

export type FileListErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type FileListError = FileListErrors[keyof FileListErrors];

export type FileListResponses = {
    /**
     * Files and directories
     */
    200: Array<FileNode>;
};

export type FileListResponse = FileListResponses[keyof FileListResponses];

export type FileReadData = {
    body?: never;
    path?: never;
    query: {
        directory?: string;
        path: string;
    };
    url: '/file/content';
};

export type FileReadErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type FileReadError = FileReadErrors[keyof FileReadErrors];

export type FileReadResponses = {
    /**
     * File content
     */
    200: FileContent;
};

export type FileReadResponse = FileReadResponses[keyof FileReadResponses];

export type FileStatusData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/file/status';
};

export type FileStatusErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type FileStatusError = FileStatusErrors[keyof FileStatusErrors];

export type FileStatusResponses = {
    /**
     * File status
     */
    200: Array<File>;
};

export type FileStatusResponse = FileStatusResponses[keyof FileStatusResponses];

export type InstanceDisposeData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/instance/dispose';
};

export type InstanceDisposeErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type InstanceDisposeError = InstanceDisposeErrors[keyof InstanceDisposeErrors];

export type InstanceDisposeResponses = {
    /**
     * Instance disposed
     */
    200: boolean;
};

export type InstanceDisposeResponse = InstanceDisposeResponses[keyof InstanceDisposeResponses];

export type PathGetData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/path';
};

export type PathGetErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type PathGetError = PathGetErrors[keyof PathGetErrors];

export type PathGetResponses = {
    /**
     * Path
     */
    200: Path;
};

export type PathGetResponse = PathGetResponses[keyof PathGetResponses];

export type RuntimeStatusData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/runtime/status';
};

export type RuntimeStatusErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type RuntimeStatusError = RuntimeStatusErrors[keyof RuntimeStatusErrors];

export type RuntimeStatusResponses = {
    /**
     * Subsystem and fallback readiness
     */
    200: RuntimeStatus;
};

export type RuntimeStatusResponse = RuntimeStatusResponses[keyof RuntimeStatusResponses];

export type VcsGetData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/vcs';
};

export type VcsGetErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type VcsGetError = VcsGetErrors[keyof VcsGetErrors];

export type VcsGetResponses = {
    /**
     * VCS info
     */
    200: VcsInfo;
};

export type VcsGetResponse = VcsGetResponses[keyof VcsGetResponses];

export type VcsStatusData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/vcs/status';
};

export type VcsStatusErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type VcsStatusError = VcsStatusErrors[keyof VcsStatusErrors];

export type VcsStatusResponses = {
    /**
     * VCS status
     */
    200: Array<VcsFileStatus>;
};

export type VcsStatusResponse = VcsStatusResponses[keyof VcsStatusResponses];

export type VcsDiffData = {
    body?: never;
    path?: never;
    query: {
        directory?: string;
        mode: 'git' | 'branch';
        context?: number;
    };
    url: '/vcs/diff';
};

export type VcsDiffErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type VcsDiffError = VcsDiffErrors[keyof VcsDiffErrors];

export type VcsDiffResponses = {
    /**
     * VCS diff
     */
    200: Array<VcsFileDiff>;
};

export type VcsDiffResponse = VcsDiffResponses[keyof VcsDiffResponses];

export type VcsDiffRawData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/vcs/diff/raw';
};

export type VcsDiffRawErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type VcsDiffRawError = VcsDiffRawErrors[keyof VcsDiffRawErrors];

export type VcsDiffRawResponses = {
    /**
     * Raw VCS diff
     */
    200: string;
};

export type VcsDiffRawResponse = VcsDiffRawResponses[keyof VcsDiffRawResponses];

export type VcsApplyData = {
    body?: {
        patch: string;
    };
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/vcs/apply';
};

export type VcsApplyErrors = {
    /**
     * VcsApplyError | InvalidRequestError
     */
    400: VcsApplyError | InvalidRequestError;
};

export type VcsApplyError2 = VcsApplyErrors[keyof VcsApplyErrors];

export type VcsApplyResponses = {
    /**
     * VCS patch applied
     */
    200: {
        applied: boolean;
    };
};

export type VcsApplyResponse = VcsApplyResponses[keyof VcsApplyResponses];

export type CommandListData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/command';
};

export type CommandListErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type CommandListError = CommandListErrors[keyof CommandListErrors];

export type CommandListResponses = {
    /**
     * List of commands
     */
    200: Array<Command>;
};

export type CommandListResponse = CommandListResponses[keyof CommandListResponses];

export type AppAgentsData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/agent';
};

export type AppAgentsErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type AppAgentsError = AppAgentsErrors[keyof AppAgentsErrors];

export type AppAgentsResponses = {
    /**
     * List of agents
     */
    200: Array<Agent>;
};

export type AppAgentsResponse = AppAgentsResponses[keyof AppAgentsResponses];

export type AppSkillsData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/skill';
};

export type AppSkillsErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type AppSkillsError = AppSkillsErrors[keyof AppSkillsErrors];

export type AppSkillsResponses = {
    /**
     * List of skills
     */
    200: Array<{
        name: string;
        description?: string;
        keywords?: Array<string>;
        location: string;
        content: string;
        tools?: Array<string>;
    }>;
};

export type AppSkillsResponse = AppSkillsResponses[keyof AppSkillsResponses];

export type FormatterStatusData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/formatter';
};

export type FormatterStatusErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type FormatterStatusError = FormatterStatusErrors[keyof FormatterStatusErrors];

export type FormatterStatusResponses = {
    /**
     * Formatter status
     */
    200: Array<FormatterStatus>;
};

export type FormatterStatusResponse = FormatterStatusResponses[keyof FormatterStatusResponses];

export type ProjectListData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/project';
};

export type ProjectListErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type ProjectListError = ProjectListErrors[keyof ProjectListErrors];

export type ProjectListResponses = {
    /**
     * List of projects
     */
    200: Array<Project>;
};

export type ProjectListResponse = ProjectListResponses[keyof ProjectListResponses];

export type ProjectCurrentData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/project/current';
};

export type ProjectCurrentErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type ProjectCurrentError = ProjectCurrentErrors[keyof ProjectCurrentErrors];

export type ProjectCurrentResponses = {
    /**
     * Current project information
     */
    200: Project;
};

export type ProjectCurrentResponse = ProjectCurrentResponses[keyof ProjectCurrentResponses];

export type ProjectInitGitData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/project/git/init';
};

export type ProjectInitGitErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type ProjectInitGitError = ProjectInitGitErrors[keyof ProjectInitGitErrors];

export type ProjectInitGitResponses = {
    /**
     * Project information after git initialization
     */
    200: Project;
};

export type ProjectInitGitResponse = ProjectInitGitResponses[keyof ProjectInitGitResponses];

export type ProjectUpdateData = {
    body?: {
        name?: string;
        icon?: {
            url?: string;
            override?: string;
            color?: string;
        };
    };
    path: {
        projectID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/project/{projectID}';
};

export type ProjectUpdateErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * ProjectNotFoundError
     */
    404: ProjectNotFoundError;
};

export type ProjectUpdateError = ProjectUpdateErrors[keyof ProjectUpdateErrors];

export type ProjectUpdateResponses = {
    /**
     * Updated project information
     */
    200: Project;
};

export type ProjectUpdateResponse = ProjectUpdateResponses[keyof ProjectUpdateResponses];

export type PtyShellsData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/pty/shells';
};

export type PtyShellsErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type PtyShellsError = PtyShellsErrors[keyof PtyShellsErrors];

export type PtyShellsResponses = {
    /**
     * List of shells
     */
    200: Array<{
        path: string;
        name: string;
        acceptable: boolean;
    }>;
};

export type PtyShellsResponse = PtyShellsResponses[keyof PtyShellsResponses];

export type PtyListData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/pty';
};

export type PtyListErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type PtyListError = PtyListErrors[keyof PtyListErrors];

export type PtyListResponses = {
    /**
     * List of sessions
     */
    200: Array<Pty>;
};

export type PtyListResponse = PtyListResponses[keyof PtyListResponses];

export type PtyCreateData = {
    body?: {
        command?: string;
        args?: Array<string>;
        cwd?: string;
        title?: string;
        env?: {
            [key: string]: string;
        };
    };
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/pty';
};

export type PtyCreateErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
};

export type PtyCreateError = PtyCreateErrors[keyof PtyCreateErrors];

export type PtyCreateResponses = {
    /**
     * Created session
     */
    200: Pty;
};

export type PtyCreateResponse = PtyCreateResponses[keyof PtyCreateResponses];

export type PtyRemoveData = {
    body?: never;
    path: {
        ptyID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/pty/{ptyID}';
};

export type PtyRemoveErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
    /**
     * PtyNotFoundError
     */
    404: PtyNotFoundError;
};

export type PtyRemoveError = PtyRemoveErrors[keyof PtyRemoveErrors];

export type PtyRemoveResponses = {
    /**
     * Session removed
     */
    200: boolean;
};

export type PtyRemoveResponse = PtyRemoveResponses[keyof PtyRemoveResponses];

export type PtyGetData = {
    body?: never;
    path: {
        ptyID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/pty/{ptyID}';
};

export type PtyGetErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
    /**
     * PtyNotFoundError
     */
    404: PtyNotFoundError;
};

export type PtyGetError = PtyGetErrors[keyof PtyGetErrors];

export type PtyGetResponses = {
    /**
     * Session info
     */
    200: Pty;
};

export type PtyGetResponse = PtyGetResponses[keyof PtyGetResponses];

export type PtyUpdateData = {
    body?: {
        title?: string;
        size?: {
            rows: number;
            cols: number;
        };
    };
    path: {
        ptyID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/pty/{ptyID}';
};

export type PtyUpdateErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * PtyNotFoundError
     */
    404: PtyNotFoundError;
};

export type PtyUpdateError = PtyUpdateErrors[keyof PtyUpdateErrors];

export type PtyUpdateResponses = {
    /**
     * Updated session
     */
    200: Pty;
};

export type PtyUpdateResponse = PtyUpdateResponses[keyof PtyUpdateResponses];

export type PtyConnectTokenData = {
    body?: never;
    path: {
        ptyID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/pty/{ptyID}/connect-token';
};

export type PtyConnectTokenErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
    /**
     * PtyForbiddenError
     */
    403: PtyForbiddenError;
    /**
     * PtyNotFoundError
     */
    404: PtyNotFoundError;
};

export type PtyConnectTokenError = PtyConnectTokenErrors[keyof PtyConnectTokenErrors];

export type PtyConnectTokenResponses = {
    /**
     * WebSocket connect token
     */
    200: {
        ticket: string;
        expires_in: number;
    };
};

export type PtyConnectTokenResponse = PtyConnectTokenResponses[keyof PtyConnectTokenResponses];

export type QuestionListData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/question';
};

export type QuestionListErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type QuestionListError = QuestionListErrors[keyof QuestionListErrors];

export type QuestionListResponses = {
    /**
     * List of pending questions
     */
    200: Array<QuestionRequest>;
};

export type QuestionListResponse = QuestionListResponses[keyof QuestionListResponses];

export type QuestionReplyData = {
    body?: {
        /**
         * User answers in order of questions (each answer is an array of selected labels)
         */
        answers: Array<QuestionAnswer>;
    };
    path: {
        requestID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/question/{requestID}/reply';
};

export type QuestionReplyErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * QuestionNotFoundError
     */
    404: QuestionNotFoundError;
};

export type QuestionReplyError = QuestionReplyErrors[keyof QuestionReplyErrors];

export type QuestionReplyResponses = {
    /**
     * Question answered successfully
     */
    200: boolean;
};

export type QuestionReplyResponse = QuestionReplyResponses[keyof QuestionReplyResponses];

export type QuestionRejectData = {
    body?: never;
    path: {
        requestID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/question/{requestID}/reject';
};

export type QuestionRejectErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * QuestionNotFoundError
     */
    404: QuestionNotFoundError;
};

export type QuestionRejectError = QuestionRejectErrors[keyof QuestionRejectErrors];

export type QuestionRejectResponses = {
    /**
     * Question rejected successfully
     */
    200: boolean;
};

export type QuestionRejectResponse = QuestionRejectResponses[keyof QuestionRejectResponses];

export type SessionListData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
        scope?: 'project';
        path?: string;
        roots?: boolean | 'true' | 'false';
        start?: number;
        search?: string;
        limit?: number;
    };
    url: '/session';
};

export type SessionListErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type SessionListError = SessionListErrors[keyof SessionListErrors];

export type SessionListResponses = {
    /**
     * List of sessions
     */
    200: Array<Session>;
};

export type SessionListResponse = SessionListResponses[keyof SessionListResponses];

export type SessionCreateData = {
    body?: {
        parentID?: string;
        title?: string;
        workflow?: string;
        agent?: string;
    };
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/session';
};

export type SessionCreateErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
};

export type SessionCreateError = SessionCreateErrors[keyof SessionCreateErrors];

export type SessionCreateResponses = {
    /**
     * Successfully created session
     */
    200: Session;
};

export type SessionCreateResponse = SessionCreateResponses[keyof SessionCreateResponses];

export type SessionStatusData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/session/status';
};

export type SessionStatusErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
};

export type SessionStatusError = SessionStatusErrors[keyof SessionStatusErrors];

export type SessionStatusResponses = {
    /**
     * Get session status
     */
    200: {
        [key: string]: SessionStatus;
    };
};

export type SessionStatusResponse = SessionStatusResponses[keyof SessionStatusResponses];

export type SessionDeleteData = {
    body?: never;
    path: {
        sessionID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}';
};

export type SessionDeleteErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
};

export type SessionDeleteError = SessionDeleteErrors[keyof SessionDeleteErrors];

export type SessionDeleteResponses = {
    /**
     * Successfully deleted session
     */
    200: boolean;
};

export type SessionDeleteResponse = SessionDeleteResponses[keyof SessionDeleteResponses];

export type SessionGetData = {
    body?: never;
    path: {
        sessionID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}';
};

export type SessionGetErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
};

export type SessionGetError = SessionGetErrors[keyof SessionGetErrors];

export type SessionGetResponses = {
    /**
     * Get session
     */
    200: Session;
};

export type SessionGetResponse = SessionGetResponses[keyof SessionGetResponses];

export type SessionUpdateData = {
    body?: {
        title?: string;
        time?: {
            archived?: number;
        };
    };
    path: {
        sessionID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}';
};

export type SessionUpdateErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
};

export type SessionUpdateError = SessionUpdateErrors[keyof SessionUpdateErrors];

export type SessionUpdateResponses = {
    /**
     * Successfully updated session
     */
    200: Session;
};

export type SessionUpdateResponse = SessionUpdateResponses[keyof SessionUpdateResponses];

export type SessionChildrenData = {
    body?: never;
    path: {
        sessionID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}/children';
};

export type SessionChildrenErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
};

export type SessionChildrenError = SessionChildrenErrors[keyof SessionChildrenErrors];

export type SessionChildrenResponses = {
    /**
     * List of children
     */
    200: Array<Session>;
};

export type SessionChildrenResponse = SessionChildrenResponses[keyof SessionChildrenResponses];

export type SessionTodoData = {
    body?: never;
    path: {
        sessionID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}/todo';
};

export type SessionTodoErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
};

export type SessionTodoError = SessionTodoErrors[keyof SessionTodoErrors];

export type SessionTodoResponses = {
    /**
     * Todo list
     */
    200: Array<Todo>;
};

export type SessionTodoResponse = SessionTodoResponses[keyof SessionTodoResponses];

export type SessionDiffData = {
    body?: never;
    path: {
        sessionID: string;
    };
    query?: {
        directory?: string;
        messageID?: string;
    };
    url: '/session/{sessionID}/diff';
};

export type SessionDiffErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type SessionDiffError = SessionDiffErrors[keyof SessionDiffErrors];

export type SessionDiffResponses = {
    /**
     * Successfully retrieved diff
     */
    200: Array<SnapshotFileDiff>;
};

export type SessionDiffResponse = SessionDiffResponses[keyof SessionDiffResponses];

export type SessionMessagesData = {
    body?: never;
    path: {
        sessionID: string;
    };
    query?: {
        directory?: string;
        limit?: number;
        before?: string;
    };
    url: '/session/{sessionID}/message';
};

export type SessionMessagesErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
};

export type SessionMessagesError = SessionMessagesErrors[keyof SessionMessagesErrors];

export type SessionMessagesResponses = {
    /**
     * List of messages
     */
    200: Array<{
        info: Message;
        parts: Array<Part>;
    }>;
};

export type SessionMessagesResponse = SessionMessagesResponses[keyof SessionMessagesResponses];

export type SessionPromptData = {
    body?: {
        messageID?: string;
        agent?: string;
        delivery?: SessionDelivery;
        noReply?: boolean;
        system?: string;
        workarea?: string;
        parts: Array<TextPartInput | FilePartInput>;
    };
    path: {
        sessionID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}/message';
};

export type SessionPromptErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
};

export type SessionPromptError = SessionPromptErrors[keyof SessionPromptErrors];

export type SessionPromptResponses = {
    /**
     * Created message
     */
    200: {
        info: AssistantMessage;
        parts: Array<Part>;
    };
};

export type SessionPromptResponse = SessionPromptResponses[keyof SessionPromptResponses];

export type SessionDeleteMessageData = {
    body?: never;
    path: {
        sessionID: string;
        messageID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}/message/{messageID}';
};

export type SessionDeleteMessageErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
    /**
     * SessionBusyError
     */
    409: SessionBusyError;
};

export type SessionDeleteMessageError = SessionDeleteMessageErrors[keyof SessionDeleteMessageErrors];

export type SessionDeleteMessageResponses = {
    /**
     * Successfully deleted message
     */
    200: boolean;
};

export type SessionDeleteMessageResponse = SessionDeleteMessageResponses[keyof SessionDeleteMessageResponses];

export type SessionMessageData = {
    body?: never;
    path: {
        sessionID: string;
        messageID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}/message/{messageID}';
};

export type SessionMessageErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
};

export type SessionMessageError = SessionMessageErrors[keyof SessionMessageErrors];

export type SessionMessageResponses = {
    /**
     * Message
     */
    200: {
        info: Message;
        parts: Array<Part>;
    };
};

export type SessionMessageResponse = SessionMessageResponses[keyof SessionMessageResponses];

export type SessionForkData = {
    body?: {
        messageID?: string;
    };
    path: {
        sessionID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}/fork';
};

export type SessionForkErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
};

export type SessionForkError = SessionForkErrors[keyof SessionForkErrors];

export type SessionForkResponses = {
    /**
     * 200
     */
    200: Session;
};

export type SessionForkResponse = SessionForkResponses[keyof SessionForkResponses];

export type SessionAbortData = {
    body?: never;
    path: {
        sessionID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}/abort';
};

export type SessionAbortErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
};

export type SessionAbortError = SessionAbortErrors[keyof SessionAbortErrors];

export type SessionAbortResponses = {
    /**
     * Aborted session
     */
    200: boolean;
};

export type SessionAbortResponse = SessionAbortResponses[keyof SessionAbortResponses];

export type SessionPromptAsyncData = {
    body?: {
        messageID?: string;
        agent?: string;
        delivery?: SessionDelivery;
        noReply?: boolean;
        system?: string;
        workarea?: string;
        parts: Array<TextPartInput | FilePartInput>;
    };
    path: {
        sessionID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}/prompt_async';
};

export type SessionPromptAsyncErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
};

export type SessionPromptAsyncError = SessionPromptAsyncErrors[keyof SessionPromptAsyncErrors];

export type SessionPromptAsyncResponses = {
    /**
     * Prompt accepted
     */
    204: void;
};

export type SessionPromptAsyncResponse = SessionPromptAsyncResponses[keyof SessionPromptAsyncResponses];

export type SessionCommandData = {
    body?: {
        messageID?: string;
        agent?: string;
        delivery?: SessionDelivery;
        arguments: string;
        command: string;
        system?: string;
        workarea?: string;
        parts?: Array<FilePartInput>;
    };
    path: {
        sessionID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}/command';
};

export type SessionCommandErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
};

export type SessionCommandError = SessionCommandErrors[keyof SessionCommandErrors];

export type SessionCommandResponses = {
    /**
     * Created message
     */
    200: {
        info: AssistantMessage;
        parts: Array<Part>;
    };
};

export type SessionCommandResponse = SessionCommandResponses[keyof SessionCommandResponses];

export type SessionShellData = {
    body?: {
        messageID?: string;
        agent: string;
        command: string;
    };
    path: {
        sessionID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}/shell';
};

export type SessionShellErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
    /**
     * SessionBusyError
     */
    409: SessionBusyError;
};

export type SessionShellError = SessionShellErrors[keyof SessionShellErrors];

export type SessionShellResponses = {
    /**
     * Created message
     */
    200: {
        info: Message;
        parts: Array<Part>;
    };
};

export type SessionShellResponse = SessionShellResponses[keyof SessionShellResponses];

export type SessionRevertData = {
    body?: {
        messageID: string;
        partID?: string;
    };
    path: {
        sessionID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}/revert';
};

export type SessionRevertErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
    /**
     * SessionBusyError
     */
    409: SessionBusyError;
};

export type SessionRevertError = SessionRevertErrors[keyof SessionRevertErrors];

export type SessionRevertResponses = {
    /**
     * Updated session
     */
    200: Session;
};

export type SessionRevertResponse = SessionRevertResponses[keyof SessionRevertResponses];

export type SessionUnrevertData = {
    body?: never;
    path: {
        sessionID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}/unrevert';
};

export type SessionUnrevertErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
    /**
     * SessionBusyError
     */
    409: SessionBusyError;
};

export type SessionUnrevertError = SessionUnrevertErrors[keyof SessionUnrevertErrors];

export type SessionUnrevertResponses = {
    /**
     * Updated session
     */
    200: Session;
};

export type SessionUnrevertResponse = SessionUnrevertResponses[keyof SessionUnrevertResponses];

export type PartDeleteData = {
    body?: never;
    path: {
        sessionID: string;
        messageID: string;
        partID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}/message/{messageID}/part/{partID}';
};

export type PartDeleteErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
};

export type PartDeleteError = PartDeleteErrors[keyof PartDeleteErrors];

export type PartDeleteResponses = {
    /**
     * Successfully deleted part
     */
    200: boolean;
};

export type PartDeleteResponse = PartDeleteResponses[keyof PartDeleteResponses];

export type PartUpdateData = {
    body?: Part;
    path: {
        sessionID: string;
        messageID: string;
        partID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/session/{sessionID}/message/{messageID}/part/{partID}';
};

export type PartUpdateErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
};

export type PartUpdateError = PartUpdateErrors[keyof PartUpdateErrors];

export type PartUpdateResponses = {
    /**
     * Successfully updated part
     */
    200: Part;
};

export type PartUpdateResponse = PartUpdateResponses[keyof PartUpdateResponses];

export type TuiAppendPromptData = {
    body?: {
        text: string;
    };
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/tui/append-prompt';
};

export type TuiAppendPromptErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
};

export type TuiAppendPromptError = TuiAppendPromptErrors[keyof TuiAppendPromptErrors];

export type TuiAppendPromptResponses = {
    /**
     * Prompt processed successfully
     */
    200: boolean;
};

export type TuiAppendPromptResponse = TuiAppendPromptResponses[keyof TuiAppendPromptResponses];

export type TuiOpenHelpData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/tui/open-help';
};

export type TuiOpenHelpErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type TuiOpenHelpError = TuiOpenHelpErrors[keyof TuiOpenHelpErrors];

export type TuiOpenHelpResponses = {
    /**
     * Help dialog opened successfully
     */
    200: boolean;
};

export type TuiOpenHelpResponse = TuiOpenHelpResponses[keyof TuiOpenHelpResponses];

export type TuiOpenSessionsData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/tui/open-sessions';
};

export type TuiOpenSessionsErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type TuiOpenSessionsError = TuiOpenSessionsErrors[keyof TuiOpenSessionsErrors];

export type TuiOpenSessionsResponses = {
    /**
     * Session dialog opened successfully
     */
    200: boolean;
};

export type TuiOpenSessionsResponse = TuiOpenSessionsResponses[keyof TuiOpenSessionsResponses];

export type TuiSubmitPromptData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/tui/submit-prompt';
};

export type TuiSubmitPromptErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type TuiSubmitPromptError = TuiSubmitPromptErrors[keyof TuiSubmitPromptErrors];

export type TuiSubmitPromptResponses = {
    /**
     * Prompt submitted successfully
     */
    200: boolean;
};

export type TuiSubmitPromptResponse = TuiSubmitPromptResponses[keyof TuiSubmitPromptResponses];

export type TuiClearPromptData = {
    body?: never;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/tui/clear-prompt';
};

export type TuiClearPromptErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type TuiClearPromptError = TuiClearPromptErrors[keyof TuiClearPromptErrors];

export type TuiClearPromptResponses = {
    /**
     * Prompt cleared successfully
     */
    200: boolean;
};

export type TuiClearPromptResponse = TuiClearPromptResponses[keyof TuiClearPromptResponses];

export type TuiExecuteCommandData = {
    body?: {
        command: string;
    };
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/tui/execute-command';
};

export type TuiExecuteCommandErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
};

export type TuiExecuteCommandError = TuiExecuteCommandErrors[keyof TuiExecuteCommandErrors];

export type TuiExecuteCommandResponses = {
    /**
     * Command executed successfully
     */
    200: boolean;
};

export type TuiExecuteCommandResponse = TuiExecuteCommandResponses[keyof TuiExecuteCommandResponses];

export type TuiShowToastData = {
    body?: {
        title?: string;
        message: string;
        variant: 'info' | 'success' | 'warning' | 'error';
        duration?: number;
    };
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/tui/show-toast';
};

export type TuiShowToastErrors = {
    /**
     * Bad request
     */
    400: BadRequestError;
};

export type TuiShowToastError = TuiShowToastErrors[keyof TuiShowToastErrors];

export type TuiShowToastResponses = {
    /**
     * Toast notification shown successfully
     */
    200: boolean;
};

export type TuiShowToastResponse = TuiShowToastResponses[keyof TuiShowToastResponses];

export type TuiPublishData = {
    body?: EventTuiPromptAppend2 | EventTuiCommandExecute2 | EventTuiToastShow2 | EventTuiSessionSelect2;
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/tui/publish';
};

export type TuiPublishErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
};

export type TuiPublishError = TuiPublishErrors[keyof TuiPublishErrors];

export type TuiPublishResponses = {
    /**
     * Event published successfully
     */
    200: boolean;
};

export type TuiPublishResponse = TuiPublishResponses[keyof TuiPublishResponses];

export type TuiSelectSessionData = {
    body?: {
        /**
         * Session ID to navigate to
         */
        sessionID: string;
    };
    path?: never;
    query?: {
        directory?: string;
    };
    url: '/tui/select-session';
};

export type TuiSelectSessionErrors = {
    /**
     * BadRequest | InvalidRequestError
     */
    400: EffectHttpApiErrorBadRequest | InvalidRequestError;
    /**
     * NotFoundError
     */
    404: NotFoundError;
};

export type TuiSelectSessionError = TuiSelectSessionErrors[keyof TuiSelectSessionErrors];

export type TuiSelectSessionResponses = {
    /**
     * Session selected successfully
     */
    200: boolean;
};

export type TuiSelectSessionResponse = TuiSelectSessionResponses[keyof TuiSelectSessionResponses];

export type PtyConnectData = {
    body?: never;
    path: {
        ptyID: string;
    };
    query?: {
        directory?: string;
    };
    url: '/pty/{ptyID}/connect';
};

export type PtyConnectErrors = {
    /**
     * Forbidden
     */
    403: EffectHttpApiErrorForbidden;
    /**
     * Not found
     */
    404: NotFoundError;
};

export type PtyConnectError = PtyConnectErrors[keyof PtyConnectErrors];

export type PtyConnectResponses = {
    /**
     * Connected session
     */
    200: boolean;
};

export type PtyConnectResponse = PtyConnectResponses[keyof PtyConnectResponses];
