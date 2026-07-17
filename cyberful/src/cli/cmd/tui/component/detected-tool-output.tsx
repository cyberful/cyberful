// ── Detected Tool Output View ────────────────────────────────────
// Cleans and syntax-highlights tool output, rendering cyberful-os metadata and
//   stdout or stderr sections without exposing its transport envelope as code.
// ─────────────────────────────────────────────────────────────────

import { createMemo, For, Match, Show, Switch } from "solid-js"
import {
  cleanToolOutputText,
  detectToolOutputFiletype,
  parseCyberfulOsToolOutput,
  type CyberfulOsToolOutput,
} from "@/cli/cmd/tool-output-language"
import { useTheme } from "@tui/context/theme"

type DetectedToolOutputProps = {
  command?: string
  content: string
  detectContent?: string
  filePath?: string
  forceFiletype?: string
  muted?: boolean
  tool?: string
  wrapMode?: "char" | "none" | "word"
}

export function DetectedToolOutput(props: DetectedToolOutputProps) {
  const content = createMemo(() => cleanToolOutputText(props.content))
  const full = createMemo(() => cleanToolOutputText(props.detectContent ?? props.content))
  const envelope = createMemo(() => {
    const complete = parseCyberfulOsToolOutput(full())
    if (!complete) return undefined
    return { complete, visible: parseCyberfulOsToolOutput(content()) }
  })

  return (
    <Show when={content()}>
      <Show when={envelope()} fallback={<ToolOutputBody {...props} content={content()} detectContent={full()} />}>
        {(value) => (
          <Show
            when={value().visible}
            fallback={<ToolOutputBody {...props} content={content()} detectContent={full()} />}
          >
            {(visible) => <CyberfulOsOutput {...props} complete={value().complete} output={visible()} />}
          </Show>
        )}
      </Show>
    </Show>
  )
}

function CyberfulOsOutput(props: DetectedToolOutputProps & { complete: CyberfulOsToolOutput; output: CyberfulOsToolOutput }) {
  const { toolOutputTheme } = useTheme()
  return (
    <box gap={1}>
      <box flexDirection="column">
        <For each={props.output.metadata}>
          {(line) => (
            <text wrapMode="none">
              <span style={{ fg: toolOutputTheme.syntaxVariable }}>{line.key}</span>
              <span style={{ fg: toolOutputTheme.syntaxOperator }}>: </span>
              <span
                style={{
                  fg:
                    (line.key === "exit_code" && line.value !== "0") ||
                    (line.key === "timed_out" && line.value === "true")
                      ? toolOutputTheme.error
                      : toolOutputTheme.text,
                }}
              >
                {line.value}
              </span>
            </text>
          )}
        </For>
      </box>
      <Show when={props.output.stdout}>
        {(stdout) => (
          <box flexDirection="column">
            <text fg={toolOutputTheme.textMuted}>stdout</text>
            <ToolOutputBody
              {...props}
              content={stdout()}
              detectContent={props.complete.stdout}
              forceFiletype={undefined}
            />
          </box>
        )}
      </Show>
      <Show when={props.output.stderr}>
        {(stderr) => (
          <box flexDirection="column">
            <text fg={toolOutputTheme.error}>stderr</text>
            <text fg={toolOutputTheme.error} wrapMode={props.wrapMode ?? "word"}>
              {stderr()}
            </text>
          </box>
        )}
      </Show>
    </box>
  )
}

function ToolOutputBody(props: DetectedToolOutputProps) {
  const { toolOutputTheme, toolSyntax, subtleToolSyntax } = useTheme()
  const filetype = createMemo(() =>
    detectToolOutputFiletype(props.detectContent ?? props.content, {
      command: props.command,
      filePath: props.filePath,
      filetype: props.forceFiletype,
      tool: props.tool,
    }),
  )
  const fg = createMemo(() => (props.muted ? toolOutputTheme.textMuted : toolOutputTheme.text))

  return (
    <Switch
      fallback={
        <text fg={fg()} wrapMode={props.wrapMode ?? "word"}>
          {props.content}
        </text>
      }
    >
      <Match when={filetype() === "markdown"}>
        <markdown
          syntaxStyle={props.muted ? subtleToolSyntax() : toolSyntax()}
          streaming={false}
          internalBlockMode="top-level"
          content={props.content}
          tableOptions={{ style: "columns", widthMode: "content" }}
          conceal={true}
          concealCode={false}
          fg={fg()}
        />
      </Match>
      <Match when={filetype()}>
        {(value) => (
          <code
            filetype={value()}
            conceal={false}
            drawUnstyledText={true}
            streaming={false}
            syntaxStyle={props.muted ? subtleToolSyntax() : toolSyntax()}
            content={props.content}
            fg={fg()}
            wrapMode={props.wrapMode ?? "word"}
          />
        )}
      </Match>
    </Switch>
  )
}
