# Terminal interface

Cyberful starts on a welcome screen that collects the workarea, workflow, and
first prompt before opening a persisted session. The terminal layout remains
usable at different window sizes and keeps transient menus in front of the
controls they describe.

## Appearance and light mode

Cyberful uses its built-in color theme; custom theme files, installation, and
selection are not part of the command or configuration surface. The fixed theme
follows the terminal's reported light or dark appearance. When a
terminal does not emit an appearance event, Cyberful infers the mode from its
background palette so a light terminal still receives the light theme on the
first frame. The full-screen TUI and `cyberful run` use the same rule.

Open the command palette with `Ctrl+P` and choose **Switch to light mode** or
**Switch to dark mode**. The same action is bound to `Ctrl+X`, then `Shift+T` by
default. A manual choice is persisted, while automatic mode remains active
until a choice is made.

The built-in light palette covers application surfaces, menus, selection text,
borders, status colors, Markdown, syntax highlighting, diffs, the welcome
splash, and direct-mode fallbacks.

`Ctrl+P` omits agent selection, status, and the diff viewer; those remain
available through `/agents`, `/status`, and `/diff`. Terminal-title, diff-wrap,
and session-directory-filter toggles are also intentionally absent from the
palette.

Press `Ctrl+Alt+K` to open the built-in keyboard guide. Its layout, pending-key
preview, home hint, diff route, notifications, and footer are part of the
terminal itself and are available for every session; they are not optional
plugins loaded from configuration.

## Welcome screen

The **Workarea** field selects the durable engagement directory used for
artifacts and evidence. Cyberful restores the last workarea asynchronously when
one is available and otherwise leaves the field empty. A workarea supplied on
the command line is displayed as a locked value. While the editable field has
focus, the white **×** at its right clears the complete value.

The **Prompt** composer accepts the initial objective. Typing `/` at the start
of the prompt opens the slash-command menu upward from the composer; typing `@`
opens reference and file suggestions. These autocomplete menus remain in the
foreground when they overlap Workarea or another welcome-screen control.
The empty composer shows an objective and example tailored to the currently
selected workflow, and updates the hint immediately when the workflow changes.
While the composer has focus, its white **×** clears all text and attachments.

Near the bottom edge, the welcome screen shows a compact dark translucent panel
centered on the screen. Its left-aligned row identifies the active Pi subsystem
and main provider. The state text is green when available,
yellow while checking or degraded, and red when the probe could not reach a
usable runtime. The snapshot is refreshed whenever the welcome route mounts; it
does not start a phase or keep an additional background service alive.

`Tab` cycles the available workflows before the first submission. The selected
workflow is fixed when the session starts.

## Session screen

After submission, Cyberful moves the prompt into the session view. The session
feed shows user messages, assistant output, tool activity, and workflow status.
The composer remains available for the next prompt or for steering an active
turn, while dialogs and full-screen feature views use higher overlay layers than
prompt autocomplete.

## Findings sidebar

Pentest, Bug Bounty, and Code Audit findings are available in a scrollable
sidebar on the right. When open, the sidebar—including its divider—uses exactly
two fifths of the available row and the session feed uses the remaining three
fifths. The two panes scroll independently.

The sidebar groups active findings by descending severity: **CRITICAL**,
**HIGH**, **MEDIUM**, **LOW**, **INFO**, then historical **UNRATED** entries.
Disproved findings remain visible in a final section. Each preview reserves
three wrapped description lines and shows the stable alias, provisional or
verified severity, current review/technical state, and Bug Bounty submission
decision as colored tags. Historical findings use **TO BE REVIEWED** and active
revisits use **IN REVIEW** without breaking severity order. Click a row, or
focus it and press `Enter`, to open the scrollable detail with evidence, gaps,
next step, and observation history by run and phase. The sidebar is
informational; it does not edit registry state.

Use `Ctrl+X`, then `F`, choose **Toggle findings** in the command palette, type
`/findings`, or click the **Findings N** composer indicator to show or hide it.
Cyberful opens it automatically when the first finding arrives only if no
preference has been recorded, then preserves the chosen visibility. Reopening
or recovering a session refreshes the sidebar from the authoritative workarea
registry, including for completed sessions.

## Following live work

The feed follows the bottom while a session is active. Scrolling upward detaches
the viewport so incoming output does not interrupt reading and shows **jump to
the bottom** beside the prompt. An active detached view returns to the bottom
after 60 seconds without manual movement; completed sessions never move
automatically.

Use `Ctrl+End` to return immediately. `PageUp` and `PageDown` move by a page;
line and half-page navigation are available through the command palette.

Tool results update their matching call card rather than adding a duplicate
row. The feed also attributes delegated actors and distinguishes model
generation from tool execution. Display state is not completion authority:
durable artifacts and validated handoffs control phase advancement.

A collapsed tool card receives at most a 12 KiB display prefix. Format
detection and cyberful-os rendering use only that prefix. If the redacted
result is larger, the card shows its preserved size and loads the first bounded
artifact block only after expansion; repeated activation loads later blocks.
The session feed folds activity locally and commits one store update per
16-millisecond frame while preserving lifecycle and call/result order. Repeated
progress updates coalesce to the latest value, and finding refreshes allow one
request per session plus one newest-revision follow-up.

A delegation appears as one live `delegate_task` card rather than separate,
apparently idle started/completed rows. The card reports its linked child run,
provider/model, elapsed time, latest activity, tool count, final state, and
failure when present.

Launch preflight prints each route's provider/model and reasoning effort. When
the configured profile resolves to another provider-supported value it uses
`requested → effective`, for example `ultra → max`. The structured run lifecycle
and `raw/operations/run-state.json` retain both values.

Context maintenance appears as one terminal timeline row. A successful memory
replacement is **Context rotated with model checkpoint**; a safe result above
the 35% target is marked partial, while summary, persistence, or irreducible-tail
failures use warning color. Deterministic tool-result archival can independently
report a muted no-op. Historical `context_compaction` transcript entries remain
readable.

Selecting a user or assistant message opens **Message Actions**. The dialog only
offers **Copy**, which places the message's visible, non-synthetic text on the
clipboard; it does not fork the session, revert history, or repopulate the
composer for editing.

If a provider stops a run, the phase status shows the normalized failure kind
and the provider's bounded, credential-redacted diagnostic. A failed phase with
no model summary uses the same host-owned diagnostic instead of reporting only
that no text was produced. Security fallback remains stricter than this display:
only a provider-structured `security_policy_block` can start it automatically;
the diagnostic text itself is never classification evidence.

Completion uses `success`, `warning`, `blocked`, or `failed`. Missing required
deliverables, invalid handoffs, provider exhaustion, and unverified cleanup are
failures—not “completed with warnings”. A warning indicates only a completed
run with non-terminal degradation. Session cleanup likewise records `closed`
only after Docker absence is verified; `closed_with_cleanup_errors` keeps
remaining resources and the lifecycle fault visible in
`raw/operations/run-state.json`.
