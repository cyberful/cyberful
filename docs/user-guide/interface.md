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

## Welcome screen

The **Workarea** field selects the durable engagement directory used for
artifacts and evidence. Cyberful restores the last workarea asynchronously when
one is available. A workarea supplied on the command line is displayed as a
locked value.

The **Prompt** composer accepts the initial objective. Typing `/` at the start
of the prompt opens the slash-command menu upward from the composer; typing `@`
opens reference and file suggestions. These autocomplete menus remain in the
foreground when they overlap Workarea or another welcome-screen control.
The empty composer shows an objective and example tailored to the currently
selected workflow, and updates the hint immediately when the workflow changes.

`Tab` cycles the available workflows before the first submission. The selected
workflow is fixed when the session starts.

## Session screen

After submission, Cyberful moves the prompt into the session view. The session
feed shows user messages, assistant output, tool activity, and workflow status.
The composer remains available for the next prompt or for steering an active
turn, while dialogs and full-screen feature views use higher overlay layers than
prompt autocomplete.

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
