// ── Typed Control-Plane SDK ───────────────────────────────────
// Exposes one typed ControlPlaneClient method for each generated server endpoint
// and routes calls through either the supplied client or the local default client.
// → cyberful/script/generate-client.ts — regenerates and patches this module.
// ─────────────────────────────────────────────────────────────────

import { buildClientParams } from './core/params.gen';
import type { Client, Options as Options2, TDataShape } from './client/types.gen';
import { client } from './client.gen';
import type { AppAgentsErrors, AppAgentsResponses, AppLogErrors, AppLogResponses, AppSkillsErrors, AppSkillsResponses, CommandListErrors, CommandListResponses, Config as Config3, ConfigGetErrors, ConfigGetResponses, ConfigUpdateErrors, ConfigUpdateResponses, EventSubscribeResponses, EventTuiCommandExecute2, EventTuiPromptAppend2, EventTuiSessionSelect2, EventTuiToastShow2, FileListErrors, FileListResponses, FilePartInput, FileReadErrors, FileReadResponses, FileStatusErrors, FileStatusResponses, FindFilesErrors, FindFilesResponses, FindTextErrors, FindTextResponses, FormatterStatusErrors, FormatterStatusResponses, GlobalConfigGetErrors, GlobalConfigGetResponses, GlobalConfigUpdateErrors, GlobalConfigUpdateResponses, GlobalDisposeErrors, GlobalDisposeResponses, GlobalEventErrors, GlobalEventResponses, GlobalHealthErrors, GlobalHealthResponses, InstanceDisposeErrors, InstanceDisposeResponses, Part as Part2, PartDeleteErrors, PartDeleteResponses, PartUpdateErrors, PartUpdateResponses, PathGetErrors, PathGetResponses, ProjectCurrentErrors, ProjectCurrentResponses, ProjectInitGitErrors, ProjectInitGitResponses, ProjectListErrors, ProjectListResponses, ProjectUpdateErrors, ProjectUpdateResponses, PtyConnectErrors, PtyConnectResponses, PtyConnectTokenErrors, PtyConnectTokenResponses, PtyCreateErrors, PtyCreateResponses, PtyGetErrors, PtyGetResponses, PtyListErrors, PtyListResponses, PtyRemoveErrors, PtyRemoveResponses, PtyShellsErrors, PtyShellsResponses, PtyUpdateErrors, PtyUpdateResponses, QuestionAnswer, QuestionListErrors, QuestionListResponses, QuestionRejectErrors, QuestionRejectResponses, QuestionReplyErrors, QuestionReplyResponses, RuntimeStatusErrors, RuntimeStatusResponses, SessionAbortErrors, SessionAbortResponses, SessionChildrenErrors, SessionChildrenResponses, SessionCommandErrors, SessionCommandResponses, SessionCreateErrors, SessionCreateResponses, SessionDeleteErrors, SessionDeleteMessageErrors, SessionDeleteMessageResponses, SessionDeleteResponses, SessionDelivery, SessionDiffErrors, SessionDiffResponses, SessionForkErrors, SessionForkResponses, SessionGetErrors, SessionGetResponses, SessionListErrors, SessionListResponses, SessionMessageErrors, SessionMessageResponses, SessionMessagesErrors, SessionMessagesResponses, SessionPromptAsyncErrors, SessionPromptAsyncResponses, SessionPromptErrors, SessionPromptResponses, SessionRevertErrors, SessionRevertResponses, SessionShellErrors, SessionShellResponses, SessionStatusErrors, SessionStatusResponses, SessionTodoErrors, SessionTodoResponses, SessionUnrevertErrors, SessionUnrevertResponses, SessionUpdateErrors, SessionUpdateResponses, TextPartInput, TuiAppendPromptErrors, TuiAppendPromptResponses, TuiClearPromptErrors, TuiClearPromptResponses, TuiExecuteCommandErrors, TuiExecuteCommandResponses, TuiOpenHelpErrors, TuiOpenHelpResponses, TuiOpenSessionsErrors, TuiOpenSessionsResponses, TuiPublishErrors, TuiPublishResponses, TuiSelectSessionErrors, TuiSelectSessionResponses, TuiShowToastErrors, TuiShowToastResponses, TuiSubmitPromptErrors, TuiSubmitPromptResponses, VcsApplyErrors, VcsApplyResponses, VcsDiffErrors, VcsDiffRawErrors, VcsDiffRawResponses, VcsDiffResponses, VcsGetErrors, VcsGetResponses, VcsStatusErrors, VcsStatusResponses } from './types.gen';

export type Options<TData extends TDataShape = TDataShape, ThrowOnError extends boolean = boolean> = Options2<TData, ThrowOnError> & {
    /**
     * You can provide a client instance returned by `createClient()` instead of
     * individual options. This might be also useful if you want to implement a
     * custom client.
     */
    client?: Client;
    /**
     * You can pass arbitrary values through the `meta` object. This can be
     * used to access values that aren't defined as part of the SDK function.
     */
    meta?: Record<string, unknown>;
};

class HeyApiClient {
    protected client: Client;
    
    constructor(args?: {
        client?: Client;
    }) {
        this.client = args?.client ?? client;
    }
}

class HeyApiRegistry<T> {
    private readonly defaultKey = 'default';
    
    private readonly instances: Map<string, T> = new Map();
    
    get(key?: string): T {
        const instance = this.instances.get(key ?? this.defaultKey);
        if (!instance) {
            throw new Error(`No control-plane client found. Create one with "new ControlPlaneClient()" to fix this error.`);
        }
        return instance;
    }
    
    set(value: T, key?: string): void {
        this.instances.set(key ?? this.defaultKey, value);
    }
}

export class App extends HeyApiClient {
    /**
     * Write log
     *
     * Write a log entry to the server logs with specified level and metadata.
     */
    public log<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
        service?: string;
        level?: 'debug' | 'info' | 'error' | 'warn';
        message?: string;
        extra?: {
            [key: string]: unknown;
        };
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'query', key: 'directory' },
                    { in: 'body', key: 'service' },
                    { in: 'body', key: 'level' },
                    { in: 'body', key: 'message' },
                    { in: 'body', key: 'extra' }
                ] }]);
        return (options?.client ?? this.client).post<AppLogResponses, AppLogErrors, ThrowOnError>({
            url: '/log',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    /**
     * List agents
     *
     * Get a list of all available AI agents in the Cyberful system.
     */
    public agents<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<AppAgentsResponses, AppAgentsErrors, ThrowOnError>({
            url: '/agent',
            ...options,
            ...params
        });
    }
    
    /**
     * List skills
     *
     * Get a list of all available skills in the Cyberful system.
     */
    public skills<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<AppSkillsResponses, AppSkillsErrors, ThrowOnError>({
            url: '/skill',
            ...options,
            ...params
        });
    }
}

export class Config extends HeyApiClient {
    /**
     * Get global configuration
     *
     * Retrieve the current global Cyberful configuration settings and preferences.
     */
    public get<ThrowOnError extends boolean = false>(options?: Options<never, ThrowOnError>) {
        return (options?.client ?? this.client).get<GlobalConfigGetResponses, GlobalConfigGetErrors, ThrowOnError>({ url: '/global/config', ...options });
    }
    
    /**
     * Update global configuration
     *
     * Update global Cyberful configuration settings and preferences.
     */
    public update<ThrowOnError extends boolean = false>(parameters?: {
        config?: Config3;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ key: 'config', map: 'body' }] }]);
        return (options?.client ?? this.client).patch<GlobalConfigUpdateResponses, GlobalConfigUpdateErrors, ThrowOnError>({
            url: '/global/config',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
}

export class Global extends HeyApiClient {
    /**
     * Get health
     *
     * Get health information about the Cyberful server.
     */
    public health<ThrowOnError extends boolean = false>(options?: Options<never, ThrowOnError>) {
        return (options?.client ?? this.client).get<GlobalHealthResponses, GlobalHealthErrors, ThrowOnError>({ url: '/global/health', ...options });
    }
    
    /**
     * Get global events
     *
     * Subscribe to global events from the Cyberful system using server-sent events.
     */
    public event<ThrowOnError extends boolean = false>(options?: Options<never, ThrowOnError>) {
        return (options?.client ?? this.client).sse.get<GlobalEventResponses, GlobalEventErrors, ThrowOnError>({ url: '/global/event', ...options });
    }
    
    /**
     * Dispose instance
     *
     * Clean up and dispose all Cyberful instances, releasing all resources.
     */
    public dispose<ThrowOnError extends boolean = false>(options?: Options<never, ThrowOnError>) {
        return (options?.client ?? this.client).post<GlobalDisposeResponses, GlobalDisposeErrors, ThrowOnError>({ url: '/global/dispose', ...options });
    }
    
    private _config?: Config;
    get config(): Config {
        return this._config ??= new Config({ client: this.client });
    }
}

export class Event extends HeyApiClient {
    /**
     * Subscribe to events
     *
     * Get events
     */
    public subscribe<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).sse.get<EventSubscribeResponses, unknown, ThrowOnError>({
            url: '/event',
            ...options,
            ...params
        });
    }
}

export class Config2 extends HeyApiClient {
    /**
     * Get configuration
     *
     * Retrieve the current Cyberful configuration settings and preferences.
     */
    public get<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<ConfigGetResponses, ConfigGetErrors, ThrowOnError>({
            url: '/config',
            ...options,
            ...params
        });
    }
    
    /**
     * Update configuration
     *
     * Update Cyberful configuration settings and preferences.
     */
    public update<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
        config?: Config3;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }, { key: 'config', map: 'body' }] }]);
        return (options?.client ?? this.client).patch<ConfigUpdateResponses, ConfigUpdateErrors, ThrowOnError>({
            url: '/config',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
}

export class Find extends HeyApiClient {
    /**
     * Find text
     *
     * Search for text patterns across files in the project using ripgrep.
     */
    public text<ThrowOnError extends boolean = false>(parameters: {
        directory?: string;
        pattern: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }, { in: 'query', key: 'pattern' }] }]);
        return (options?.client ?? this.client).get<FindTextResponses, FindTextErrors, ThrowOnError>({
            url: '/find',
            ...options,
            ...params
        });
    }
    
    /**
     * Find files
     *
     * Search for files or directories by name or pattern in the project directory.
     */
    public files<ThrowOnError extends boolean = false>(parameters: {
        directory?: string;
        query: string;
        dirs?: 'true' | 'false';
        type?: 'file' | 'directory';
        limit?: number;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'query', key: 'directory' },
                    { in: 'query', key: 'query' },
                    { in: 'query', key: 'dirs' },
                    { in: 'query', key: 'type' },
                    { in: 'query', key: 'limit' }
                ] }]);
        return (options?.client ?? this.client).get<FindFilesResponses, FindFilesErrors, ThrowOnError>({
            url: '/find/file',
            ...options,
            ...params
        });
    }
}

export class File extends HeyApiClient {
    /**
     * List files
     *
     * List files and directories in a specified path.
     */
    public list<ThrowOnError extends boolean = false>(parameters: {
        directory?: string;
        path: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }, { in: 'query', key: 'path' }] }]);
        return (options?.client ?? this.client).get<FileListResponses, FileListErrors, ThrowOnError>({
            url: '/file',
            ...options,
            ...params
        });
    }
    
    /**
     * Read file
     *
     * Read the content of a specified file.
     */
    public read<ThrowOnError extends boolean = false>(parameters: {
        directory?: string;
        path: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }, { in: 'query', key: 'path' }] }]);
        return (options?.client ?? this.client).get<FileReadResponses, FileReadErrors, ThrowOnError>({
            url: '/file/content',
            ...options,
            ...params
        });
    }
    
    /**
     * Get file status
     *
     * Get the git status of all files in the project.
     */
    public status<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<FileStatusResponses, FileStatusErrors, ThrowOnError>({
            url: '/file/status',
            ...options,
            ...params
        });
    }
}

export class Instance extends HeyApiClient {
    /**
     * Dispose instance
     *
     * Clean up and dispose the current Cyberful instance, releasing all resources.
     */
    public dispose<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).post<InstanceDisposeResponses, InstanceDisposeErrors, ThrowOnError>({
            url: '/instance/dispose',
            ...options,
            ...params
        });
    }
}

export class Path extends HeyApiClient {
    /**
     * Get paths
     *
     * Retrieve the current working directory and related path information for the Cyberful instance.
     */
    public get<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<PathGetResponses, PathGetErrors, ThrowOnError>({
            url: '/path',
            ...options,
            ...params
        });
    }
}

export class Runtime extends HeyApiClient {
    /**
     * Get runtime status
     *
     * Probe the active subsystem and optional local fallback server.
     */
    public status<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<RuntimeStatusResponses, RuntimeStatusErrors, ThrowOnError>({
            url: '/runtime/status',
            ...options,
            ...params
        });
    }
}

export class Diff extends HeyApiClient {
    /**
     * Get raw VCS diff
     *
     * Retrieve a raw patch for current uncommitted changes.
     */
    public raw<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<VcsDiffRawResponses, VcsDiffRawErrors, ThrowOnError>({
            url: '/vcs/diff/raw',
            ...options,
            ...params
        });
    }
}

export class Vcs extends HeyApiClient {
    /**
     * Get VCS info
     *
     * Retrieve version control system (VCS) information for the current project, such as git branch.
     */
    public get<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<VcsGetResponses, VcsGetErrors, ThrowOnError>({
            url: '/vcs',
            ...options,
            ...params
        });
    }
    
    /**
     * Get VCS status
     *
     * Retrieve changed files in the current working tree without patches.
     */
    public status<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<VcsStatusResponses, VcsStatusErrors, ThrowOnError>({
            url: '/vcs/status',
            ...options,
            ...params
        });
    }
    
    /**
     * Get VCS diff
     *
     * Retrieve the current git diff for the working tree or against the default branch.
     */
    public diff<ThrowOnError extends boolean = false>(parameters: {
        directory?: string;
        mode: 'git' | 'branch';
        context?: number;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'query', key: 'directory' },
                    { in: 'query', key: 'mode' },
                    { in: 'query', key: 'context' }
                ] }]);
        return (options?.client ?? this.client).get<VcsDiffResponses, VcsDiffErrors, ThrowOnError>({
            url: '/vcs/diff',
            ...options,
            ...params
        });
    }
    
    /**
     * Apply VCS patch
     *
     * Apply a raw patch to the current working tree.
     */
    public apply<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
        patch?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }, { in: 'body', key: 'patch' }] }]);
        return (options?.client ?? this.client).post<VcsApplyResponses, VcsApplyErrors, ThrowOnError>({
            url: '/vcs/apply',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    private _diff?: Diff;
    get diff2(): Diff {
        return this._diff ??= new Diff({ client: this.client });
    }
}

export class Command extends HeyApiClient {
    /**
     * List commands
     *
     * Get a list of all available commands in the Cyberful system.
     */
    public list<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<CommandListResponses, CommandListErrors, ThrowOnError>({
            url: '/command',
            ...options,
            ...params
        });
    }
}

export class Formatter extends HeyApiClient {
    /**
     * Get formatter status
     *
     * Get formatter status
     */
    public status<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<FormatterStatusResponses, FormatterStatusErrors, ThrowOnError>({
            url: '/formatter',
            ...options,
            ...params
        });
    }
}

export class Project extends HeyApiClient {
    /**
     * List all projects
     *
     * Get a list of projects that have been opened with Cyberful.
     */
    public list<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<ProjectListResponses, ProjectListErrors, ThrowOnError>({
            url: '/project',
            ...options,
            ...params
        });
    }
    
    /**
     * Get current project
     *
     * Retrieve the currently active project that Cyberful is working with.
     */
    public current<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<ProjectCurrentResponses, ProjectCurrentErrors, ThrowOnError>({
            url: '/project/current',
            ...options,
            ...params
        });
    }
    
    /**
     * Initialize git repository
     *
     * Create a git repository for the current project and return the refreshed project info.
     */
    public initGit<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).post<ProjectInitGitResponses, ProjectInitGitErrors, ThrowOnError>({
            url: '/project/git/init',
            ...options,
            ...params
        });
    }
    
    /**
     * Update project
     *
     * Update project properties such as name and icon.
     */
    public update<ThrowOnError extends boolean = false>(parameters: {
        projectID: string;
        directory?: string;
        name?: string;
        icon?: {
            url?: string;
            override?: string;
            color?: string;
        };
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'path', key: 'projectID' },
                    { in: 'query', key: 'directory' },
                    { in: 'body', key: 'name' },
                    { in: 'body', key: 'icon' }
                ] }]);
        return (options?.client ?? this.client).patch<ProjectUpdateResponses, ProjectUpdateErrors, ThrowOnError>({
            url: '/project/{projectID}',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
}

export class Pty extends HeyApiClient {
    /**
     * List available shells
     *
     * Get a list of available shells on the system.
     */
    public shells<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<PtyShellsResponses, PtyShellsErrors, ThrowOnError>({
            url: '/pty/shells',
            ...options,
            ...params
        });
    }
    
    /**
     * List PTY sessions
     *
     * Get a list of all active pseudo-terminal (PTY) sessions managed by Cyberful.
     */
    public list<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<PtyListResponses, PtyListErrors, ThrowOnError>({
            url: '/pty',
            ...options,
            ...params
        });
    }
    
    /**
     * Create PTY session
     *
     * Create a new pseudo-terminal (PTY) session for running shell commands and processes.
     */
    public create<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
        command?: string;
        args?: Array<string>;
        cwd?: string;
        title?: string;
        env?: {
            [key: string]: string;
        };
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'query', key: 'directory' },
                    { in: 'body', key: 'command' },
                    { in: 'body', key: 'args' },
                    { in: 'body', key: 'cwd' },
                    { in: 'body', key: 'title' },
                    { in: 'body', key: 'env' }
                ] }]);
        return (options?.client ?? this.client).post<PtyCreateResponses, PtyCreateErrors, ThrowOnError>({
            url: '/pty',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    /**
     * Remove PTY session
     *
     * Remove and terminate a specific pseudo-terminal (PTY) session.
     */
    public remove<ThrowOnError extends boolean = false>(parameters: {
        ptyID: string;
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'path', key: 'ptyID' }, { in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).delete<PtyRemoveResponses, PtyRemoveErrors, ThrowOnError>({
            url: '/pty/{ptyID}',
            ...options,
            ...params
        });
    }
    
    /**
     * Get PTY session
     *
     * Retrieve detailed information about a specific pseudo-terminal (PTY) session.
     */
    public get<ThrowOnError extends boolean = false>(parameters: {
        ptyID: string;
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'path', key: 'ptyID' }, { in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<PtyGetResponses, PtyGetErrors, ThrowOnError>({
            url: '/pty/{ptyID}',
            ...options,
            ...params
        });
    }
    
    /**
     * Update PTY session
     *
     * Update properties of an existing pseudo-terminal (PTY) session.
     */
    public update<ThrowOnError extends boolean = false>(parameters: {
        ptyID: string;
        directory?: string;
        title?: string;
        size?: {
            rows: number;
            cols: number;
        };
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'path', key: 'ptyID' },
                    { in: 'query', key: 'directory' },
                    { in: 'body', key: 'title' },
                    { in: 'body', key: 'size' }
                ] }]);
        return (options?.client ?? this.client).put<PtyUpdateResponses, PtyUpdateErrors, ThrowOnError>({
            url: '/pty/{ptyID}',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    /**
     * Create PTY WebSocket token
     *
     * Create a short-lived ticket for opening a PTY WebSocket connection.
     */
    public connectToken<ThrowOnError extends boolean = false>(parameters: {
        ptyID: string;
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'path', key: 'ptyID' }, { in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).post<PtyConnectTokenResponses, PtyConnectTokenErrors, ThrowOnError>({
            url: '/pty/{ptyID}/connect-token',
            ...options,
            ...params
        });
    }
    
    /**
     * Connect to PTY session
     *
     * Establish a WebSocket connection to interact with a pseudo-terminal (PTY) session in real-time.
     */
    public connect<ThrowOnError extends boolean = false>(parameters: {
        ptyID: string;
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'path', key: 'ptyID' }, { in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<PtyConnectResponses, PtyConnectErrors, ThrowOnError>({
            url: '/pty/{ptyID}/connect',
            ...options,
            ...params
        });
    }
}

export class Question extends HeyApiClient {
    /**
     * List pending questions
     *
     * Get all pending question requests across all sessions.
     */
    public list<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<QuestionListResponses, QuestionListErrors, ThrowOnError>({
            url: '/question',
            ...options,
            ...params
        });
    }
    
    /**
     * Reply to question request
     *
     * Provide answers to a question request from the AI assistant.
     */
    public reply<ThrowOnError extends boolean = false>(parameters: {
        requestID: string;
        directory?: string;
        answers?: Array<QuestionAnswer>;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'path', key: 'requestID' },
                    { in: 'query', key: 'directory' },
                    { in: 'body', key: 'answers' }
                ] }]);
        return (options?.client ?? this.client).post<QuestionReplyResponses, QuestionReplyErrors, ThrowOnError>({
            url: '/question/{requestID}/reply',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    /**
     * Reject question request
     *
     * Reject a question request from the AI assistant.
     */
    public reject<ThrowOnError extends boolean = false>(parameters: {
        requestID: string;
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'path', key: 'requestID' }, { in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).post<QuestionRejectResponses, QuestionRejectErrors, ThrowOnError>({
            url: '/question/{requestID}/reject',
            ...options,
            ...params
        });
    }
}

export class Session extends HeyApiClient {
    /**
     * List sessions
     *
     * Get a list of all Cyberful sessions, sorted by most recently updated.
     */
    public list<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
        scope?: 'project';
        path?: string;
        roots?: boolean | 'true' | 'false';
        start?: number;
        search?: string;
        limit?: number;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'query', key: 'directory' },
                    { in: 'query', key: 'scope' },
                    { in: 'query', key: 'path' },
                    { in: 'query', key: 'roots' },
                    { in: 'query', key: 'start' },
                    { in: 'query', key: 'search' },
                    { in: 'query', key: 'limit' }
                ] }]);
        return (options?.client ?? this.client).get<SessionListResponses, SessionListErrors, ThrowOnError>({
            url: '/session',
            ...options,
            ...params
        });
    }
    
    /**
     * Create session
     *
     * Create a new Cyberful session for interacting with AI assistants and managing conversations.
     */
    public create<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
        parentID?: string;
        title?: string;
        workflow?: string;
        agent?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'query', key: 'directory' },
                    { in: 'body', key: 'parentID' },
                    { in: 'body', key: 'title' },
                    { in: 'body', key: 'workflow' },
                    { in: 'body', key: 'agent' }
                ] }]);
        return (options?.client ?? this.client).post<SessionCreateResponses, SessionCreateErrors, ThrowOnError>({
            url: '/session',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    /**
     * Get session status
     *
     * Retrieve the current status of all sessions, including active, idle, and completed states.
     */
    public status<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<SessionStatusResponses, SessionStatusErrors, ThrowOnError>({
            url: '/session/status',
            ...options,
            ...params
        });
    }
    
    /**
     * Delete session
     *
     * Delete a session and permanently remove all associated data, including messages and history.
     */
    public delete<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'path', key: 'sessionID' }, { in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).delete<SessionDeleteResponses, SessionDeleteErrors, ThrowOnError>({
            url: '/session/{sessionID}',
            ...options,
            ...params
        });
    }
    
    /**
     * Get session
     *
     * Retrieve detailed information about a specific Cyberful session.
     */
    public get<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'path', key: 'sessionID' }, { in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<SessionGetResponses, SessionGetErrors, ThrowOnError>({
            url: '/session/{sessionID}',
            ...options,
            ...params
        });
    }
    
    /**
     * Update session
     *
     * Update properties of an existing session, such as title or other metadata.
     */
    public update<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        directory?: string;
        title?: string;
        time?: {
            archived?: number;
        };
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'path', key: 'sessionID' },
                    { in: 'query', key: 'directory' },
                    { in: 'body', key: 'title' },
                    { in: 'body', key: 'time' }
                ] }]);
        return (options?.client ?? this.client).patch<SessionUpdateResponses, SessionUpdateErrors, ThrowOnError>({
            url: '/session/{sessionID}',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    /**
     * Get session children
     *
     * Retrieve all child sessions that were forked from the specified parent session.
     */
    public children<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'path', key: 'sessionID' }, { in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<SessionChildrenResponses, SessionChildrenErrors, ThrowOnError>({
            url: '/session/{sessionID}/children',
            ...options,
            ...params
        });
    }
    
    /**
     * Get session todos
     *
     * Retrieve the todo list associated with a specific session, showing tasks and action items.
     */
    public todo<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'path', key: 'sessionID' }, { in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).get<SessionTodoResponses, SessionTodoErrors, ThrowOnError>({
            url: '/session/{sessionID}/todo',
            ...options,
            ...params
        });
    }
    
    /**
     * Get message diff
     *
     * Get the file changes (diff) that resulted from a specific user message in the session.
     */
    public diff<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        directory?: string;
        messageID?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'path', key: 'sessionID' },
                    { in: 'query', key: 'directory' },
                    { in: 'query', key: 'messageID' }
                ] }]);
        return (options?.client ?? this.client).get<SessionDiffResponses, SessionDiffErrors, ThrowOnError>({
            url: '/session/{sessionID}/diff',
            ...options,
            ...params
        });
    }
    
    /**
     * Get session messages
     *
     * Retrieve all messages in a session, including user prompts and AI responses.
     */
    public messages<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        directory?: string;
        limit?: number;
        before?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'path', key: 'sessionID' },
                    { in: 'query', key: 'directory' },
                    { in: 'query', key: 'limit' },
                    { in: 'query', key: 'before' }
                ] }]);
        return (options?.client ?? this.client).get<SessionMessagesResponses, SessionMessagesErrors, ThrowOnError>({
            url: '/session/{sessionID}/message',
            ...options,
            ...params
        });
    }
    
    /**
     * Send message
     *
     * Create and send a new message to a session, streaming the AI response.
     */
    public prompt<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        directory?: string;
        messageID?: string;
        agent?: string;
        delivery?: SessionDelivery;
        noReply?: boolean;
        system?: string;
        workarea?: string;
        parts?: Array<TextPartInput | FilePartInput>;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'path', key: 'sessionID' },
                    { in: 'query', key: 'directory' },
                    { in: 'body', key: 'messageID' },
                    { in: 'body', key: 'agent' },
                    { in: 'body', key: 'delivery' },
                    { in: 'body', key: 'noReply' },
                    { in: 'body', key: 'system' },
                    { in: 'body', key: 'workarea' },
                    { in: 'body', key: 'parts' }
                ] }]);
        return (options?.client ?? this.client).post<SessionPromptResponses, SessionPromptErrors, ThrowOnError>({
            url: '/session/{sessionID}/message',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    /**
     * Delete message
     *
     * Permanently delete a specific message and all of its parts from a session without reverting file changes.
     */
    public deleteMessage<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        messageID: string;
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'path', key: 'sessionID' },
                    { in: 'path', key: 'messageID' },
                    { in: 'query', key: 'directory' }
                ] }]);
        return (options?.client ?? this.client).delete<SessionDeleteMessageResponses, SessionDeleteMessageErrors, ThrowOnError>({
            url: '/session/{sessionID}/message/{messageID}',
            ...options,
            ...params
        });
    }
    
    /**
     * Get message
     *
     * Retrieve a specific message from a session by its message ID.
     */
    public message<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        messageID: string;
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'path', key: 'sessionID' },
                    { in: 'path', key: 'messageID' },
                    { in: 'query', key: 'directory' }
                ] }]);
        return (options?.client ?? this.client).get<SessionMessageResponses, SessionMessageErrors, ThrowOnError>({
            url: '/session/{sessionID}/message/{messageID}',
            ...options,
            ...params
        });
    }
    
    /**
     * Fork session
     *
     * Create a new session by forking an existing session at a specific message point.
     */
    public fork<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        directory?: string;
        messageID?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'path', key: 'sessionID' },
                    { in: 'query', key: 'directory' },
                    { in: 'body', key: 'messageID' }
                ] }]);
        return (options?.client ?? this.client).post<SessionForkResponses, SessionForkErrors, ThrowOnError>({
            url: '/session/{sessionID}/fork',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    /**
     * Abort session
     *
     * Abort an active session and stop any ongoing AI processing or command execution.
     */
    public abort<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'path', key: 'sessionID' }, { in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).post<SessionAbortResponses, SessionAbortErrors, ThrowOnError>({
            url: '/session/{sessionID}/abort',
            ...options,
            ...params
        });
    }
    
    /**
     * Send async message
     *
     * Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.
     */
    public promptAsync<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        directory?: string;
        messageID?: string;
        agent?: string;
        delivery?: SessionDelivery;
        noReply?: boolean;
        system?: string;
        workarea?: string;
        parts?: Array<TextPartInput | FilePartInput>;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'path', key: 'sessionID' },
                    { in: 'query', key: 'directory' },
                    { in: 'body', key: 'messageID' },
                    { in: 'body', key: 'agent' },
                    { in: 'body', key: 'delivery' },
                    { in: 'body', key: 'noReply' },
                    { in: 'body', key: 'system' },
                    { in: 'body', key: 'workarea' },
                    { in: 'body', key: 'parts' }
                ] }]);
        return (options?.client ?? this.client).post<SessionPromptAsyncResponses, SessionPromptAsyncErrors, ThrowOnError>({
            url: '/session/{sessionID}/prompt_async',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    /**
     * Send command
     *
     * Send a new command to a session for execution by the AI assistant.
     */
    public command<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        directory?: string;
        messageID?: string;
        agent?: string;
        delivery?: SessionDelivery;
        arguments?: string;
        command?: string;
        system?: string;
        workarea?: string;
        parts?: Array<FilePartInput>;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'path', key: 'sessionID' },
                    { in: 'query', key: 'directory' },
                    { in: 'body', key: 'messageID' },
                    { in: 'body', key: 'agent' },
                    { in: 'body', key: 'delivery' },
                    { in: 'body', key: 'arguments' },
                    { in: 'body', key: 'command' },
                    { in: 'body', key: 'system' },
                    { in: 'body', key: 'workarea' },
                    { in: 'body', key: 'parts' }
                ] }]);
        return (options?.client ?? this.client).post<SessionCommandResponses, SessionCommandErrors, ThrowOnError>({
            url: '/session/{sessionID}/command',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    /**
     * Run shell command
     *
     * Execute a shell command within the session context and return the AI's response.
     */
    public shell<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        directory?: string;
        messageID?: string;
        agent?: string;
        command?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'path', key: 'sessionID' },
                    { in: 'query', key: 'directory' },
                    { in: 'body', key: 'messageID' },
                    { in: 'body', key: 'agent' },
                    { in: 'body', key: 'command' }
                ] }]);
        return (options?.client ?? this.client).post<SessionShellResponses, SessionShellErrors, ThrowOnError>({
            url: '/session/{sessionID}/shell',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    /**
     * Revert message
     *
     * Revert a specific message in a session, undoing its effects and restoring the previous state.
     */
    public revert<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        directory?: string;
        messageID?: string;
        partID?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'path', key: 'sessionID' },
                    { in: 'query', key: 'directory' },
                    { in: 'body', key: 'messageID' },
                    { in: 'body', key: 'partID' }
                ] }]);
        return (options?.client ?? this.client).post<SessionRevertResponses, SessionRevertErrors, ThrowOnError>({
            url: '/session/{sessionID}/revert',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    /**
     * Restore reverted messages
     *
     * Restore all previously reverted messages in a session.
     */
    public unrevert<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'path', key: 'sessionID' }, { in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).post<SessionUnrevertResponses, SessionUnrevertErrors, ThrowOnError>({
            url: '/session/{sessionID}/unrevert',
            ...options,
            ...params
        });
    }
}

export class Part extends HeyApiClient {
    /**
     * Delete a part from a message.
     */
    public delete<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        messageID: string;
        partID: string;
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'path', key: 'sessionID' },
                    { in: 'path', key: 'messageID' },
                    { in: 'path', key: 'partID' },
                    { in: 'query', key: 'directory' }
                ] }]);
        return (options?.client ?? this.client).delete<PartDeleteResponses, PartDeleteErrors, ThrowOnError>({
            url: '/session/{sessionID}/message/{messageID}/part/{partID}',
            ...options,
            ...params
        });
    }
    
    /**
     * Update a part in a message.
     */
    public update<ThrowOnError extends boolean = false>(parameters: {
        sessionID: string;
        messageID: string;
        partID: string;
        directory?: string;
        part?: Part2;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'path', key: 'sessionID' },
                    { in: 'path', key: 'messageID' },
                    { in: 'path', key: 'partID' },
                    { in: 'query', key: 'directory' },
                    { key: 'part', map: 'body' }
                ] }]);
        return (options?.client ?? this.client).patch<PartUpdateResponses, PartUpdateErrors, ThrowOnError>({
            url: '/session/{sessionID}/message/{messageID}/part/{partID}',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
}

export class Tui extends HeyApiClient {
    /**
     * Append TUI prompt
     *
     * Append prompt to the TUI.
     */
    public appendPrompt<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
        text?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }, { in: 'body', key: 'text' }] }]);
        return (options?.client ?? this.client).post<TuiAppendPromptResponses, TuiAppendPromptErrors, ThrowOnError>({
            url: '/tui/append-prompt',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    /**
     * Open help dialog
     *
     * Open the help dialog in the TUI to display user assistance information.
     */
    public openHelp<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).post<TuiOpenHelpResponses, TuiOpenHelpErrors, ThrowOnError>({
            url: '/tui/open-help',
            ...options,
            ...params
        });
    }
    
    /**
     * Open sessions dialog
     *
     * Open the session dialog.
     */
    public openSessions<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).post<TuiOpenSessionsResponses, TuiOpenSessionsErrors, ThrowOnError>({
            url: '/tui/open-sessions',
            ...options,
            ...params
        });
    }
    
    /**
     * Submit TUI prompt
     *
     * Submit the prompt.
     */
    public submitPrompt<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).post<TuiSubmitPromptResponses, TuiSubmitPromptErrors, ThrowOnError>({
            url: '/tui/submit-prompt',
            ...options,
            ...params
        });
    }
    
    /**
     * Clear TUI prompt
     *
     * Clear the prompt.
     */
    public clearPrompt<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }] }]);
        return (options?.client ?? this.client).post<TuiClearPromptResponses, TuiClearPromptErrors, ThrowOnError>({
            url: '/tui/clear-prompt',
            ...options,
            ...params
        });
    }
    
    /**
     * Execute TUI command
     *
     * Execute a TUI command.
     */
    public executeCommand<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
        command?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }, { in: 'body', key: 'command' }] }]);
        return (options?.client ?? this.client).post<TuiExecuteCommandResponses, TuiExecuteCommandErrors, ThrowOnError>({
            url: '/tui/execute-command',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    /**
     * Show TUI toast
     *
     * Show a toast notification in the TUI.
     */
    public showToast<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
        title?: string;
        message?: string;
        variant?: 'info' | 'success' | 'warning' | 'error';
        duration?: number;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [
                    { in: 'query', key: 'directory' },
                    { in: 'body', key: 'title' },
                    { in: 'body', key: 'message' },
                    { in: 'body', key: 'variant' },
                    { in: 'body', key: 'duration' }
                ] }]);
        return (options?.client ?? this.client).post<TuiShowToastResponses, TuiShowToastErrors, ThrowOnError>({
            url: '/tui/show-toast',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    /**
     * Publish TUI event
     *
     * Publish a TUI event.
     */
    public publish<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
        body?: EventTuiPromptAppend2 | EventTuiCommandExecute2 | EventTuiToastShow2 | EventTuiSessionSelect2;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }, { key: 'body', map: 'body' }] }]);
        return (options?.client ?? this.client).post<TuiPublishResponses, TuiPublishErrors, ThrowOnError>({
            url: '/tui/publish',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
    
    /**
     * Select session
     *
     * Navigate the TUI to display the specified session.
     */
    public selectSession<ThrowOnError extends boolean = false>(parameters?: {
        directory?: string;
        sessionID?: string;
    }, options?: Options<never, ThrowOnError>) {
        const params = buildClientParams([parameters], [{ args: [{ in: 'query', key: 'directory' }, { in: 'body', key: 'sessionID' }] }]);
        return (options?.client ?? this.client).post<TuiSelectSessionResponses, TuiSelectSessionErrors, ThrowOnError>({
            url: '/tui/select-session',
            ...options,
            ...params,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
                ...params.headers
            }
        });
    }
}

export class ControlPlaneClient extends HeyApiClient {
    public static readonly __registry = new HeyApiRegistry<ControlPlaneClient>();
    
    constructor(args?: {
        client?: Client;
        key?: string;
    }) {
        super(args);
        ControlPlaneClient.__registry.set(this, args?.key);
    }
    
    private _app?: App;
    get app(): App {
        return this._app ??= new App({ client: this.client });
    }
    
    private _global?: Global;
    get global(): Global {
        return this._global ??= new Global({ client: this.client });
    }
    
    private _event?: Event;
    get event(): Event {
        return this._event ??= new Event({ client: this.client });
    }
    
    private _config?: Config2;
    get config(): Config2 {
        return this._config ??= new Config2({ client: this.client });
    }
    
    private _find?: Find;
    get find(): Find {
        return this._find ??= new Find({ client: this.client });
    }
    
    private _file?: File;
    get file(): File {
        return this._file ??= new File({ client: this.client });
    }
    
    private _instance?: Instance;
    get instance(): Instance {
        return this._instance ??= new Instance({ client: this.client });
    }
    
    private _path?: Path;
    get path(): Path {
        return this._path ??= new Path({ client: this.client });
    }

    private _runtime?: Runtime;
    get runtime(): Runtime {
        return this._runtime ??= new Runtime({ client: this.client });
    }
    
    private _vcs?: Vcs;
    get vcs(): Vcs {
        return this._vcs ??= new Vcs({ client: this.client });
    }
    
    private _command?: Command;
    get command(): Command {
        return this._command ??= new Command({ client: this.client });
    }
    
    private _formatter?: Formatter;
    get formatter(): Formatter {
        return this._formatter ??= new Formatter({ client: this.client });
    }
    
    private _project?: Project;
    get project(): Project {
        return this._project ??= new Project({ client: this.client });
    }
    
    private _pty?: Pty;
    get pty(): Pty {
        return this._pty ??= new Pty({ client: this.client });
    }
    
    private _question?: Question;
    get question(): Question {
        return this._question ??= new Question({ client: this.client });
    }
    
    private _session?: Session;
    get session(): Session {
        return this._session ??= new Session({ client: this.client });
    }
    
    private _part?: Part;
    get part(): Part {
        return this._part ??= new Part({ client: this.client });
    }
    
    private _tui?: Tui;
    get tui(): Tui {
        return this._tui ??= new Tui({ client: this.client });
    }
}
