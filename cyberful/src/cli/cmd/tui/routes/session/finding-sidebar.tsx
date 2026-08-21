// ── Findings And Hypotheses Sidebar ──────────────────────────────
// Projects finding and active-hypothesis registries into ordered preview cards
//   and read-only detail dialogs, with independent clipping and scrolling.
// → cyberful/src/cli/cmd/tui/context/sync.tsx — supplies live registry snapshots.
// ─────────────────────────────────────────────────────────────────

import type {
  FindingRegistryView,
  SessionHypothesisRegistryView,
  WorkareaFinding,
} from "@/server/client"
import { Locale } from "@/util/locale"
import { TextAttributes, type KeyEvent } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { useTuiConfig } from "@tui/context/tui-config"
import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { useDialog } from "../../ui/dialog"
import { getScrollAcceleration } from "../../util/scroll"

type FindingObservation = WorkareaFinding["observations"][number]
type AssessedObservation = Extract<FindingObservation, { review: "ASSESSED" }>
type FindingTechnicalState = AssessedObservation["disposition"]["state"]
type FindingSeverity = FindingObservation["severity"]
type FindingMaturation = NonNullable<FindingObservation["maturation"]>
type HypothesisItem = SessionHypothesisRegistryView["activeHypotheses"][number]
type FindingRewardValue = {
  minimum: number | string
  maximum: number | string
  unit: "MONEY" | "POINTS"
  currency?: string
}

type FindingRow = {
  finding: WorkareaFinding
  observation: FindingObservation | undefined
  current: FindingObservation | undefined
  historical: boolean
}

const severityOrder: FindingSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO", "UNRATED"]
const stateRank: Record<FindingTechnicalState, number> = {
  CONFIRMED: 0,
  SUSPECTED: 1,
  INCONCLUSIVE: 2,
  UNTESTABLE: 3,
  DISPROVED: 4,
}

export function findingSplitWidths(available: number, open: boolean) {
  const sidebar = open ? Math.floor(available / 3) : 0
  return { feed: available - sidebar, sidebar }
}

function assessed(value: FindingObservation | undefined): value is AssessedObservation {
  return value?.review === "ASSESSED"
}

export function findingRows(view: FindingRegistryView | undefined): FindingRow[] {
  if (!view) return []
  return view.registry.findings.map((finding) => {
    const current = finding.observations.findLast((item) => item.runID === view.runID)
    const observation =
      current ?? finding.observations.findLast((item): item is AssessedObservation => item.review === "ASSESSED")
    const historical = current === undefined
    return { finding, observation, current, historical }
  })
}

export function findingGroups(view: FindingRegistryView | undefined) {
  const rows = findingRows(view)
  const sortRows = (findings: FindingRow[]) =>
    findings.toSorted(
      (left, right) =>
        Number(left.historical) - Number(right.historical) ||
        stateRank[technicalState(left)] - stateRank[technicalState(right)] ||
        right.finding.updatedAt.localeCompare(left.finding.updatedAt),
    )
  const active = rows.filter((item) => technicalState(item) !== "DISPROVED")
  const groups = severityOrder.flatMap((severityValue) => {
    const findings = sortRows(active.filter((item) => severity(item) === severityValue))
    return findings.length > 0
      ? [{ group: `${severityValue} · ${findings.length}`, severity: severityValue, findings }]
      : []
  })
  const disproved = sortRows(rows.filter((item) => technicalState(item) === "DISPROVED"))
  return disproved.length > 0
    ? [...groups, { group: `DISPROVED · ${disproved.length}`, severity: undefined, findings: disproved }]
    : groups
}

function primaryAlias(finding: WorkareaFinding) {
  return finding.aliases[0] ?? finding.id
}

function technicalState(row: FindingRow) {
  if (assessed(row.observation)) return row.observation.disposition.state
  return row.observation?.carriedState ?? "SUSPECTED"
}

function submission(row: FindingRow) {
  return row.observation?.submission.result ?? "NOT_ASSESSED"
}

function severity(row: FindingRow) {
  return row.observation?.severity ?? "UNRATED"
}

function rowState(row: FindingRow) {
  if (row.historical) return "TO BE REVIEWED"
  if (row.current?.review === "IN_REVIEW") return "IN REVIEW"
  return technicalState(row)
}

function provisionalSeverity(row: FindingRow) {
  if (!row.observation || row.observation.review === "IN_REVIEW") return true
  return row.observation.verification.result === "NOT_REVIEWED"
}

function rewardAmount(value: FindingRewardValue | undefined) {
  if (!value || typeof value.minimum !== "number" || typeof value.maximum !== "number") return
  const amount = value.minimum === value.maximum ? `${value.minimum}` : `${value.minimum}–${value.maximum}`
  return value.unit === "MONEY" ? `${value.currency ?? "currency"} ${amount}` : `${amount} pts`
}

export function findingRewardSummary(maturation: FindingMaturation | undefined) {
  const reward = maturation?.checkpoint?.reward
  if (!reward) return
  const current = rewardAmount(reward.current)
  const target = rewardAmount(reward.target)
  const upside = rewardAmount(reward.upside)
  if (!current && !target) return reward.policyKind.replaceAll("_", " ")
  return `${current ?? "unmapped"}${target ? ` → ${target}` : ""}${upside ? ` · +${upside}` : ""}`
}

export function findingTag(value: string) {
  return `[${value.replaceAll("_", " ")}]`
}

export function activeHypothesisLabel(value: number): string | undefined {
  const count = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  if (count === 0) return
  return `(i) ${count} active ${count === 1 ? "hypothesis" : "hypotheses"}`
}

export function sidebarContentKinds(
  view: FindingRegistryView | undefined,
  hypotheses: SessionHypothesisRegistryView | undefined,
) {
  return [
    ...(findingGroups(view).length > 0 ? (["findings"] as const) : []),
    ...((hypotheses?.activeHypotheses.length ?? 0) > 0 ? (["hypotheses"] as const) : []),
  ]
}

export function findingSeverityTone(value: FindingSeverity) {
  if (value === "CRITICAL") return "error" as const
  if (value === "HIGH") return "warning" as const
  if (value === "MEDIUM") return "accent" as const
  if (value === "LOW") return "info" as const
  return "textMuted" as const
}

function severityTag(row: FindingRow) {
  const value = severity(row)
  return findingTag(value === "UNRATED" || !provisionalSeverity(row) ? value : `PROVISIONAL ${value}`)
}

export function FindingSidebar(props: {
  width: number
  view: FindingRegistryView | undefined
  hypotheses?: SessionHypothesisRegistryView
  onOpen: (finding: WorkareaFinding) => void
  onOpenHypothesis: (hypothesis: HypothesisItem) => void
}) {
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const groups = createMemo(() => findingGroups(props.view))
  const count = createMemo(() => props.view?.registry.findings.length ?? 0)
  const hypothesisItems = createMemo(() => props.hypotheses?.activeHypotheses ?? [])
  const activeHypothesisCount = createMemo(() => Number(props.hypotheses?.activeCount ?? 0))
  const hypothesisLabel = createMemo(() => activeHypothesisLabel(activeHypothesisCount()))
  const contentKinds = createMemo(() => sidebarContentKinds(props.view, props.hypotheses))
  const [focused, setFocused] = createSignal<string>()
  const [hovered, setHovered] = createSignal<string>()
  const severityColor = (value: FindingSeverity) => theme[findingSeverityTone(value)]
  const stateColor = (row: FindingRow) => {
    const value = rowState(row)
    if (value === "CONFIRMED") return theme.success
    if (value === "SUSPECTED" || value === "IN REVIEW") return theme.accent
    if (value === "INCONCLUSIVE" || value === "UNTESTABLE" || value === "TO BE REVIEWED") return theme.warning
    return theme.textMuted
  }
  const submissionColor = (value: string) => {
    if (value === "SUBMISSION_READY") return theme.success
    if (value === "NEEDS_MORE_EVIDENCE") return theme.warning
    return theme.textMuted
  }

  return (
    <box
      width={props.width}
      flexShrink={0}
      minHeight={0}
      border={["left"]}
      borderColor={theme.border}
      paddingTop={1}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      overflow="hidden"
    >
      <box
        height={3}
        width="100%"
        flexShrink={0}
        flexDirection="column"
        justifyContent="center"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.backgroundElement}
      >
        <box width="100%" alignItems="center" justifyContent="space-between" flexDirection="row">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Findings
          </text>
          <text fg={theme.textMuted}>{`${count()} · #R${props.view?.registry.revision ?? 0}`}</text>
        </box>
      </box>
      <Show
        when={contentKinds().length > 0}
        fallback={
          <box paddingTop={1}>
            <text fg={theme.textMuted} wrapMode="word">
              No findings or active hypotheses recorded.
            </text>
          </box>
        }
      >
        <scrollbox
          width="100%"
          flexGrow={1}
          minHeight={0}
          scrollAcceleration={getScrollAcceleration(tuiConfig)}
          verticalScrollbarOptions={{
            visible: true,
            trackOptions: {
              backgroundColor: theme.backgroundElement,
              foregroundColor: theme.border,
            },
          }}
          horizontalScrollbarOptions={{ visible: false }}
        >
          <Show when={groups().length === 0 && hypothesisItems().length > 0}>
            <box width="100%" paddingTop={1} paddingBottom={1}>
              <text fg={theme.textMuted}>0</text>
            </box>
          </Show>
          <For each={groups()}>
            {(section) => (
              <box width="100%" flexDirection="column" overflow="hidden">
                <text
                  marginBottom={1}
                  fg={section.severity ? severityColor(section.severity) : theme.textMuted}
                  attributes={TextAttributes.BOLD}
                >
                  {section.group}
                </text>
                <For each={section.findings}>
                  {(row) => {
                    const rowID = `finding:${row.finding.id}`
                    const active = () => focused() === rowID || hovered() === rowID
                    const open = () => props.onOpen(row.finding)
                    return (
                      <box
                        focusable={true}
                        width="100%"
                        flexDirection="column"
                        paddingLeft={1}
                        paddingRight={1}
                        marginBottom={2}
                        overflow="hidden"
                        backgroundColor={active() ? theme.backgroundElement : theme.background}
                        on:focused={() => setFocused(rowID)}
                        on:blurred={() => setFocused(undefined)}
                        onMouseOver={() => setHovered(rowID)}
                        onMouseOut={() => setHovered(undefined)}
                        onMouseDown={(event) => event.target?.focus()}
                        onMouseUp={open}
                        onKeyDown={(event: KeyEvent) => {
                          if (event.name !== "return") return
                          event.preventDefault()
                          open()
                        }}
                      >
                        <text
                          width="100%"
                          overflow="hidden"
                          wrapMode="none"
                          truncate
                          fg={theme.text}
                          attributes={TextAttributes.BOLD}
                        >
                          {primaryAlias(row.finding)}
                        </text>
                        <text height={3} width="100%" overflow="hidden" wrapMode="word" fg={theme.text}>
                          {row.finding.title}
                        </text>
                        <text width="100%" overflow="hidden" wrapMode="none" truncate>
                          <span style={{ fg: severityColor(severity(row)) }}>{severityTag(row)}</span>
                          <span style={{ fg: stateColor(row) }}>{`  ${findingTag(rowState(row))}`}</span>
                        </text>
                        <text
                          width="100%"
                          overflow="hidden"
                          wrapMode="none"
                          truncate
                          fg={submissionColor(submission(row))}
                        >
                          {findingTag(submission(row))}
                        </text>
                        <Show
                          when={
                            row.finding.origin.workflow === "bug-bounty"
                              ? findingRewardSummary(row.observation?.maturation)
                              : undefined
                          }
                        >
                          {(reward) => (
                            <text width="100%" overflow="hidden" wrapMode="none" truncate fg={theme.success}>
                              {`Reward ${reward()}`}
                            </text>
                          )}
                        </Show>
                      </box>
                    )
                  }}
                </For>
              </box>
            )}
          </For>
          <Show when={hypothesisItems().length > 0}>
            <box width="100%" height={1} flexShrink={0} border={["top"]} borderColor={theme.border} />
          </Show>
          <Show when={hypothesisLabel()}>
            {(label) => (
              <text marginBottom={1} fg={theme.textMuted} wrapMode="none" truncate>
                {label()}
              </text>
            )}
          </Show>
          <For each={hypothesisItems()}>
            {(hypothesis) => {
              const rowID = `hypothesis:${hypothesis.id}`
              const active = () => focused() === rowID || hovered() === rowID
              const open = () => props.onOpenHypothesis(hypothesis)
              return (
                <box
                  focusable={true}
                  width="100%"
                  flexDirection="column"
                  paddingLeft={1}
                  paddingRight={1}
                  marginBottom={2}
                  overflow="hidden"
                  backgroundColor={active() ? theme.backgroundElement : theme.background}
                  on:focused={() => setFocused(rowID)}
                  on:blurred={() => setFocused(undefined)}
                  onMouseOver={() => setHovered(rowID)}
                  onMouseOut={() => setHovered(undefined)}
                  onMouseDown={(event) => event.target?.focus()}
                  onMouseUp={open}
                  onKeyDown={(event: KeyEvent) => {
                    if (event.name !== "return") return
                    event.preventDefault()
                    open()
                  }}
                >
                  <text
                    width="100%"
                    overflow="hidden"
                    wrapMode="none"
                    truncate
                    fg={theme.textMuted}
                    attributes={TextAttributes.BOLD}
                  >
                    {hypothesis.id}
                  </text>
                  <text height={3} width="100%" overflow="hidden" wrapMode="word" fg={theme.textMuted}>
                    {hypothesis.description}
                  </text>
                  <text width="100%" overflow="hidden" wrapMode="none" truncate fg={theme.textMuted}>
                    {`${findingTag(hypothesis.state)}  ${hypothesis.phase}`}
                  </text>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </Show>
    </box>
  )
}

export function DialogHypothesis(props: { hypothesis: HypothesisItem }) {
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const { theme } = useTheme()
  onMount(() => dialog.setSize("xlarge"))

  return (
    <box
      height={findingDialogHeight(dimensions().height)}
      minHeight={0}
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      overflow="hidden"
    >
      <box height={3} width="100%" flexShrink={0} flexDirection="column" gap={1} overflow="hidden">
        <text
          height={1}
          width="100%"
          overflow="hidden"
          fg={theme.text}
          attributes={TextAttributes.BOLD}
          wrapMode="none"
          truncate
        >
          {props.hypothesis.description}
        </text>
        <text height={1} width="100%" overflow="hidden" fg={theme.textMuted} wrapMode="none" truncate>
          {`${props.hypothesis.id} · ${props.hypothesis.state} · ${props.hypothesis.phase}`}
        </text>
      </box>
      <scrollbox
        marginTop={1}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        width="100%"
        stickyScroll={false}
        scrollAcceleration={getScrollAcceleration(tuiConfig)}
        verticalScrollbarOptions={{ visible: true }}
        horizontalScrollbarOptions={{ visible: false }}
      >
        <text fg={theme.textMuted} wrapMode="word">
          {`Owner: ${props.hypothesis.ownerDisplayName ?? props.hypothesis.owner}`}
        </text>
        <text marginTop={1} fg={theme.textMuted} attributes={TextAttributes.BOLD}>
          ROOT CAUSE
        </text>
        <text fg={theme.text} wrapMode="word">
          {props.hypothesis.rootCause}
        </text>
        <text marginTop={1} fg={theme.textMuted} attributes={TextAttributes.BOLD}>
          SURFACE
        </text>
        <text fg={theme.text} wrapMode="word">
          {props.hypothesis.surface}
        </text>
        <text marginTop={1} fg={theme.textMuted} attributes={TextAttributes.BOLD}>
          DISCRIMINATOR
        </text>
        <text fg={theme.text} wrapMode="word">
          {props.hypothesis.discriminator}
        </text>
        <Show when={props.hypothesis.oracle}>
          {(oracle) => (
            <>
              <text marginTop={1} fg={theme.textMuted} attributes={TextAttributes.BOLD}>
                ORACLE
              </text>
              <text fg={theme.text} wrapMode="word">{`Observe: ${oracle().primary_observation}`}</text>
              <text fg={theme.text} wrapMode="word">{`Positive: ${oracle().positive_condition}`}</text>
              <text fg={theme.text} wrapMode="word">{`Negative: ${oracle().negative_condition}`}</text>
              <text fg={theme.text} wrapMode="word">{`Invalid: ${oracle().invalid_condition}`}</text>
              <Show when={oracle().controls.length > 0}>
                <text fg={theme.textMuted} wrapMode="word">{`Controls: ${oracle().controls.join("; ")}`}</text>
              </Show>
            </>
          )}
        </Show>
        <Show when={props.hypothesis.latestTestResult}>
          {(result) => (
            <>
              <text marginTop={1} fg={theme.textMuted} attributes={TextAttributes.BOLD}>
                LATEST TEST RESULT
              </text>
              <text fg={theme.text} wrapMode="word">{`${result().match}: ${result().observation}`}</text>
              <text fg={theme.textMuted} wrapMode="word">{result().interpretation}</text>
              <text fg={theme.textMuted} wrapMode="word">
                {`Primary evidence: ${result().primary_evidence_paths.join(", ")}`}
              </text>
              <Show when={result().derived_evidence_paths.length > 0}>
                <text fg={theme.textMuted} wrapMode="word">
                  {`Derived evidence: ${result().derived_evidence_paths.join(", ")}`}
                </text>
              </Show>
              <For each={result().conflicts}>
                {(conflict) => <text fg={theme.warning} wrapMode="word">{`Conflict: ${conflict}`}</text>}
              </For>
            </>
          )}
        </Show>
        <text marginTop={1} fg={theme.textMuted} attributes={TextAttributes.BOLD}>
          CANDIDATE TOOLS
        </text>
        <text fg={theme.text} wrapMode="word">
          {props.hypothesis.candidateTools.join(", ") || "None recorded."}
        </text>
        <Show when={props.hypothesis.omittedTools.length > 0}>
          <text marginTop={1} fg={theme.textMuted} attributes={TextAttributes.BOLD}>
            OMITTED TOOLS
          </text>
          <For each={props.hypothesis.omittedTools}>
            {(item) => <text fg={theme.text} wrapMode="word">{`• ${item.tool} — ${item.reason}`}</text>}
          </For>
        </Show>
        <Show when={props.hypothesis.findingID}>
          {(findingID) => <text marginTop={1} fg={theme.textMuted}>{`Linked finding: ${findingID()}`}</text>}
        </Show>
        <Show when={props.hypothesis.blocker}>
          {(blocker) => (
            <text marginTop={1} fg={theme.text} wrapMode="word">
              {`Blocker${props.hypothesis.blockerReason ? ` (${props.hypothesis.blockerReason})` : ""}: ${blocker()}`}
            </text>
          )}
        </Show>
        <Show when={props.hypothesis.nextStep}>
          {(nextStep) => (
            <text marginTop={1} fg={theme.text} wrapMode="word">
              {`Next step${props.hypothesis.nextPhase ? ` (${props.hypothesis.nextPhase})` : ""}: ${nextStep()}`}
            </text>
          )}
        </Show>
        <Show when={props.hypothesis.evidence.length > 0}>
          <text marginTop={2} fg={theme.textMuted} attributes={TextAttributes.BOLD}>
            EVIDENCE
          </text>
          <For each={props.hypothesis.evidence}>
            {(item) => <text fg={theme.text} wrapMode="word">{`• ${item}`}</text>}
          </For>
        </Show>
        <Show when={props.hypothesis.evidenceRefs.length > 0}>
          <text marginTop={1} fg={theme.textMuted} wrapMode="word">
            {`Evidence references: ${props.hypothesis.evidenceRefs.join(", ")}`}
          </text>
        </Show>
        <Show when={props.hypothesis.graphRefs.length > 0}>
          <text marginTop={1} fg={theme.textMuted} wrapMode="word">
            {`Graph references: ${props.hypothesis.graphRefs.join(", ")}`}
          </text>
        </Show>
        <Show when={props.hypothesis.transitions.length > 0}>
          <text marginTop={2} fg={theme.textMuted} attributes={TextAttributes.BOLD}>
            {`HISTORY · ${props.hypothesis.transitions.length}`}
          </text>
          <For each={props.hypothesis.transitions.toReversed()}>
            {(transition) => (
              <box
                width="100%"
                flexDirection="column"
                marginTop={1}
                paddingLeft={1}
                border={["left"]}
                borderColor={theme.border}
                overflow="hidden"
              >
                <text width="100%" overflow="hidden" wrapMode="none" truncate fg={theme.textMuted}>
                  {`${transition.from ? `${transition.from} → ` : ""}${transition.to} · ${transition.phase} · ${Locale.time(new Date(transition.time).getTime())}`}
                </text>
                <Show when={transition.reason}>
                  {(reason) => <text fg={theme.text} wrapMode="word">{reason()}</text>}
                </Show>
                <For each={transition.evidence}>
                  {(item) => <text fg={theme.textMuted} wrapMode="word">{`• ${item}`}</text>}
                </For>
                <Show when={transition.testResult}>
                  {(result) => (
                    <text fg={theme.textMuted} wrapMode="word">
                      {`${result().match} · primary ${result().primary_evidence_paths.join(", ")}`}
                    </text>
                  )}
                </Show>
              </box>
            )}
          </For>
        </Show>
      </scrollbox>
      <text marginTop={1} fg={theme.textMuted}>
        Esc closes · scroll for the complete details
      </text>
    </box>
  )
}

export function DialogFinding(props: { finding: WorkareaFinding; runID: string }) {
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const { theme } = useTheme()
  const latest = createMemo(() => props.finding.observations.at(-1))
  const history = createMemo(() => props.finding.observations.slice(0, -1).toReversed())
  onMount(() => dialog.setSize("xlarge"))

  return (
    <box
      height={findingDialogHeight(dimensions().height)}
      minHeight={0}
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      overflow="hidden"
    >
      <box height={3} width="100%" flexShrink={0} flexDirection="column" gap={1} overflow="hidden">
        <text
          height={1}
          width="100%"
          overflow="hidden"
          fg={theme.text}
          attributes={TextAttributes.BOLD}
          wrapMode="none"
          truncate
        >
          {props.finding.title}
        </text>
        <text height={1} width="100%" overflow="hidden" fg={theme.textMuted} wrapMode="none" truncate>
          {[props.finding.id, ...props.finding.aliases].join(" · ")}
        </text>
      </box>
      <scrollbox
        marginTop={1}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        width="100%"
        stickyScroll={false}
        scrollAcceleration={getScrollAcceleration(tuiConfig)}
        verticalScrollbarOptions={{ visible: true }}
        horizontalScrollbarOptions={{ visible: false }}
      >
        <text fg={theme.textMuted}>{`Origin: ${props.finding.origin.workflow} / ${props.finding.origin.source}`}</text>
        <Show when={latest()}>
          {(observation) => (
            <>
              <text marginTop={1} fg={theme.accent} attributes={TextAttributes.BOLD}>
                LATEST OBSERVATION
              </text>
              <FindingObservationCard observation={observation()} runID={props.runID} expanded />
            </>
          )}
        </Show>
        <Show when={history().length > 0}>
          <text marginTop={2} fg={theme.textMuted} attributes={TextAttributes.BOLD}>
            {`HISTORY · ${history().length} earlier observation${history().length === 1 ? "" : "s"}`}
          </text>
          <For each={history()}>
            {(observation) => <FindingObservationCard observation={observation} runID={props.runID} expanded={false} />}
          </For>
        </Show>
      </scrollbox>
      <text marginTop={1} fg={theme.textMuted}>
        Esc closes · scroll for the complete history
      </text>
    </box>
  )
}

export function findingDialogHeight(terminalHeight: number) {
  if (terminalHeight <= 4) return Math.max(1, terminalHeight)
  return Math.min(terminalHeight - 2, Math.max(8, Math.floor(terminalHeight * 0.72)))
}

function FindingObservationCard(props: { observation: FindingObservation; runID: string; expanded: boolean }) {
  const { theme } = useTheme()
  const relation = () =>
    props.expanded
      ? props.observation.runID === props.runID
        ? "CURRENT RUN"
        : "HISTORICAL"
      : props.observation.runID === props.runID
        ? "EARLIER · CURRENT RUN"
        : "HISTORICAL"

  return (
    <box
      width="100%"
      flexDirection="column"
      marginTop={1}
      paddingLeft={1}
      paddingRight={1}
      border={["left"]}
      borderColor={props.expanded ? theme.accent : theme.border}
      overflow="hidden"
    >
      <text width="100%" overflow="hidden" wrapMode="none" truncate>
        <span style={{ fg: props.expanded ? theme.accent : theme.textMuted }}>{relation()}</span>
        <span style={{ fg: theme.textMuted }}>
          {` · ${props.observation.phase} · ${Locale.time(new Date(props.observation.timestamp).getTime())}`}
        </span>
      </text>
      <Show
        when={assessed(props.observation) ? props.observation : undefined}
        fallback={
          <>
            <text fg={theme.warning}>IN REVIEW</text>
            <text fg={theme.text} wrapMode="word">
              {`Summary: ${props.observation.summary}`}
            </text>
            <Show when={props.expanded && props.observation.review === "IN_REVIEW"}>
              <text fg={theme.text} wrapMode="word">
                {`Next step: ${props.observation.review === "IN_REVIEW" ? props.observation.plan : ""}`}
              </text>
            </Show>
          </>
        }
      >
        {(item) => (
          <>
            <text width="100%" overflow="hidden" wrapMode="none" truncate fg={theme.textMuted}>
              {`${item().severity} · ${item().disposition.state} · verification ${item().verification.result} · submission ${item().submission.result}`}
            </text>
            <text fg={theme.text} wrapMode="word">
              {`${props.expanded ? "Summary: " : ""}${item().summary}`}
            </text>
            <Show when={props.expanded}>
              <text fg={theme.text} wrapMode="word">
                {`Evidence / gap: ${dispositionDetail(item())}`}
              </text>
              <Show when={item().verification.rationale}>
                {(value) => <text fg={theme.textMuted} wrapMode="word">{`Verification: ${value()}`}</text>}
              </Show>
              <Show when={item().submission.rationale}>
                {(value) => <text fg={theme.textMuted} wrapMode="word">{`Submission: ${value()}`}</text>}
              </Show>
              <Show when={item().maturation?.assessment}>
                {(assessment) => (
                  <>
                    <text fg={theme.info} wrapMode="word">
                      {`Maturation: ${assessment().status} · ${assessment().currentImpact}`}
                    </text>
                    <Show when={assessment().targetSeverity}>
                      {(target) => <text fg={theme.textMuted}>{`Target severity: ${target()}`}</text>}
                    </Show>
                    <Show when={assessment().evidenceGap}>
                      {(gap) => <text fg={theme.textMuted} wrapMode="word">{`Evidence gap: ${gap()}`}</text>}
                    </Show>
                    <Show when={assessment().nextTest}>
                      {(next) => <text fg={theme.textMuted} wrapMode="word">{`Next test: ${next()}`}</text>}
                    </Show>
                    <Show when={assessment().conclusion}>
                      {(conclusion) => (
                        <text fg={theme.textMuted} wrapMode="word">{`Conclusion: ${conclusion()}`}</text>
                      )}
                    </Show>
                  </>
                )}
              </Show>
            </Show>
            <Show when={findingRewardSummary(item().maturation)}>
              {(reward) => <text fg={theme.success} wrapMode="word">{`Published reward: ${reward()}`}</text>}
            </Show>
            <Show when={item().maturation?.checkpoint}>
              {(checkpoint) => (
                <>
                  <text fg={theme.info}>Finding maturation questions</text>
                  <For each={checkpoint().questions}>
                    {(question, index) => (
                      <text fg={theme.textMuted} wrapMode="word">{`${index() + 1}. ${question}`}</text>
                    )}
                  </For>
                </>
              )}
            </Show>
          </>
        )}
      </Show>
      <Show when={props.observation.evidencePaths.length > 0}>
        <text
          width="100%"
          overflow="hidden"
          wrapMode={props.expanded ? "word" : "none"}
          truncate={!props.expanded}
          fg={theme.textMuted}
        >
          {`Evidence: ${props.observation.evidencePaths.join(", ")}`}
        </text>
      </Show>
    </box>
  )
}

function dispositionDetail(observation: AssessedObservation) {
  const value = observation.disposition
  if (value.state === "SUSPECTED")
    return `${value.positiveEvidence}${value.nextStep ? ` · next step: ${value.nextStep}` : ""}`
  if (value.state === "INCONCLUSIVE") return `${value.ambiguity} · next step: ${value.nextStep}`
  if (value.state === "UNTESTABLE") return `${value.blockerKind}: ${value.blockerReason} · next step: ${value.nextStep}`
  if (value.state === "CONFIRMED") return value.proof
  return value.reason
}
