// ── Prompt Mention Autocomplete ──────────────────────────────────
// Searches files, agents, references, and slash commands at the active trigger,
//   ranks them by fuzzy score and frecency, and replaces the selected text range.
// ─────────────────────────────────────────────────────────────────

import type { BoxRenderable, TextareaRenderable, ScrollBoxRenderable } from "@opentui/core"
import { pathToFileURL } from "bun"
import fuzzysort from "fuzzysort"
import path from "node:path"
import { firstBy } from "remeda"
import { createMemo, createResource, createEffect, onMount, onCleanup, Index, Show, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { getScrollAcceleration } from "../../util/scroll"
import { useTuiConfig } from "../../context/tui-config"
import { useTheme, selectedForeground } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"
import { useTerminalDimensions } from "@opentui/solid"
import { Locale } from "@/util/locale"
import type { PromptInfo } from "./history"
import { useFrecency } from "./frecency"
import { useBindings, useCommandSlashes, useCyberfulModeStack } from "../../keymap"
import { Reference } from "@/reference/reference"
import { ConfigReference } from "@/config/reference"
import { displayCharAt, mentionTriggerIndex } from "@/cli/cmd/prompt-display"

export const PROMPT_OVERLAY_Z_INDEX = 2000

function removeLineRange(input: string) {
  const hashIndex = input.lastIndexOf("#")
  return hashIndex !== -1 ? input.substring(0, hashIndex) : input
}

function extractLineRange(input: string) {
  const hashIndex = input.lastIndexOf("#")
  if (hashIndex === -1) {
    return { baseQuery: input }
  }

  const baseName = input.substring(0, hashIndex)
  const linePart = input.substring(hashIndex + 1)
  const lineMatch = linePart.match(/^(\d+)(?:-(\d*))?$/)

  if (!lineMatch) {
    return { baseQuery: baseName }
  }

  const startLine = Number(lineMatch[1])
  const endLine = lineMatch[2] && startLine < Number(lineMatch[2]) ? Number(lineMatch[2]) : undefined

  return {
    lineRange: {
      baseName,
      startLine,
      endLine,
    },
    baseQuery: baseName,
  }
}

export type AutocompleteRef = {
  onInput: (value: string) => void
  visible: false | "@" | "/"
}

export type AutocompleteOption = {
  display: string
  value?: string
  aliases?: string[]
  disabled?: boolean
  description?: string
  isDirectory?: boolean
  onSelect?: () => void
  path?: string
}

export function Autocomplete(props: {
  value: string
  sessionID?: string
  setPrompt: (input: (prompt: PromptInfo) => void) => void
  setExtmark: (partIndex: number, extmarkId: number) => void
  anchor: () => BoxRenderable
  input: () => TextareaRenderable
  ref: (ref: AutocompleteRef) => void
  fileStyleId: number
  promptPartTypeId: () => number
}) {
  const sdk = useSDK()
  const sync = useSync()
  const slashes = useCommandSlashes()
  const modeStack = useCyberfulModeStack()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const frecency = useFrecency()
  const tuiConfig = useTuiConfig()
  const [store, setStore] = createStore<{
    index: number
    selected: number
    visible: AutocompleteRef["visible"]
    input: "keyboard" | "mouse"
  }>({
    index: 0,
    selected: 0,
    visible: false,
    input: "keyboard",
  })

  const [positionTick, setPositionTick] = createSignal(0)

  createEffect(() => {
    if (!store.visible) return
    const popMode = modeStack.push("autocomplete")
    onCleanup(popMode)
  })

  createEffect(() => {
    if (store.visible) {
      let lastPos = { x: 0, y: 0, width: 0 }
      const interval = setInterval(() => {
        const anchor = props.anchor()
        if (anchor.x !== lastPos.x || anchor.y !== lastPos.y || anchor.width !== lastPos.width) {
          lastPos = { x: anchor.x, y: anchor.y, width: anchor.width }
          setPositionTick((t) => t + 1)
        }
      }, 50)

      onCleanup(() => clearInterval(interval))
    }
  })

  const position = createMemo(() => {
    if (!store.visible) return { x: 0, y: 0, width: 0 }
    dimensions()
    positionTick()
    const anchor = props.anchor()
    const parent = anchor.parent
    const parentX = parent?.x ?? 0
    const parentY = parent?.y ?? 0

    return {
      x: anchor.x - parentX,
      y: anchor.y - parentY,
      width: anchor.width,
    }
  })

  // ── Search Waits For Textarea State To Settle ───────────────────
  // Text content is reactive through `props.value`, while cursor and range reads
  // come from the imperative textarea. A key event can update those sources at
  // slightly different times. The filter memo records the reactive dependency,
  // and the following effect copies its post-render result so every consumer
  // ranks one stable query rather than a transient partial string.
  // ─────────────────────────────────────────────────────────────────
  const filter = createMemo(() => {
    if (!store.visible) return
    props.value

    return props.input().getTextRange(store.index + 1, props.input().cursorOffset)
  })

  const [search, setSearch] = createSignal("")
  createEffect(() => {
    const next = filter()
    setSearch(next ? next : "")
  })

  // ── Filtering Retains Keyboard Selection Ownership ─────────────
  // Changing the result layout can synthesize a mouse move beneath a stationary
  // pointer. Treating that event as intent would jump selection away from the
  // user's keyboard result. Every filter change therefore resets input ownership
  // before the moved rows can process hover state.
  // ─────────────────────────────────────────────────────────────────
  createEffect(() => {
    filter()
    setStore("input", "keyboard")
  })

  function insertPart(text: string, part: PromptInfo["parts"][number]) {
    const input = props.input()
    const currentCursorOffset = input.cursorOffset

    const charAfterCursor = displayCharAt(props.value, currentCursorOffset)
    const needsSpace = charAfterCursor !== " "
    const append = "@" + text + (needsSpace ? " " : "")

    input.cursorOffset = store.index
    const startCursor = input.logicalCursor
    input.cursorOffset = currentCursorOffset
    const endCursor = input.logicalCursor

    input.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)
    input.insertText(append)

    const virtualText = "@" + text
    const extmarkStart = store.index
    const extmarkEnd = extmarkStart + Bun.stringWidth(virtualText)

    const styleId = part.type === "file" ? props.fileStyleId : undefined

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId,
      typeId: props.promptPartTypeId(),
    })

    props.setPrompt((draft) => {
      if (part.type === "file") {
        const existingIndex = draft.parts.findIndex((p) => p.type === "file" && "url" in p && p.url === part.url)
        if (existingIndex !== -1) {
          const existing = draft.parts[existingIndex]
          if (
            part.source?.text &&
            existing &&
            "source" in existing &&
            existing.source &&
            "text" in existing.source &&
            existing.source.text
          ) {
            existing.source.text.start = extmarkStart
            existing.source.text.end = extmarkEnd
            existing.source.text.value = virtualText
          }
          return
        }
      }

      if (part.type === "file" && part.source?.text) {
        part.source.text.start = extmarkStart
        part.source.text.end = extmarkEnd
        part.source.text.value = virtualText
      }
      const partIndex = draft.parts.length
      draft.parts.push(part)
      props.setExtmark(partIndex, extmarkId)
    })

    if (part.type === "file" && part.source && part.source.type === "file") {
      frecency.updateFrecency(part.source.path)
    }
  }

  function createFilePart(item: string, lineRange?: { startLine: number; endLine?: number }) {
    const baseDir = (sync.path.directory || process.cwd()).replace(/\/+$/, "")
    const fullPath = path.isAbsolute(item) ? item : path.join(baseDir, item)
    const urlObj = pathToFileURL(fullPath)
    const filename =
      lineRange && !item.endsWith("/")
        ? `${item}#${lineRange.startLine}${lineRange.endLine ? `-${lineRange.endLine}` : ""}`
        : item

    if (lineRange && !item.endsWith("/")) {
      urlObj.searchParams.set("start", String(lineRange.startLine))
      if (lineRange.endLine !== undefined) {
        urlObj.searchParams.set("end", String(lineRange.endLine))
      }
    }

    return {
      filename,
      url: urlObj.href,
      part: {
        type: "file" as const,
        mime: "text/plain",
        filename,
        url: urlObj.href,
        source: {
          type: "file" as const,
          text: {
            start: 0,
            end: 0,
            value: "",
          },
          path: item,
        },
      },
    }
  }

  function createReferenceFilePart(input: {
    alias: string
    root: string
    item: string
    lineRange?: { startLine: number; endLine?: number }
  }) {
    const filename = `${input.alias}/${
      input.lineRange && !input.item.endsWith("/")
        ? `${input.item}#${input.lineRange.startLine}${input.lineRange.endLine ? `-${input.lineRange.endLine}` : ""}`
        : input.item
    }`
    const urlObj = pathToFileURL(path.join(input.root, input.item))

    if (input.lineRange && !input.item.endsWith("/")) {
      urlObj.searchParams.set("start", String(input.lineRange.startLine))
      if (input.lineRange.endLine !== undefined) {
        urlObj.searchParams.set("end", String(input.lineRange.endLine))
      }
    }

    return {
      filename,
      url: urlObj.href,
      part: {
        type: "file" as const,
        mime: input.item.endsWith("/") ? "application/x-directory" : "text/plain",
        filename,
        url: urlObj.href,
        source: {
          type: "file" as const,
          text: {
            start: 0,
            end: 0,
            value: "",
          },
          path: filename,
        },
      },
    }
  }

  function referencePromptText(reference: Reference.Resolved) {
    const problem = reference.kind === "invalid" ? reference.message : undefined
    return [
      `Referenced configured reference @${reference.name}.`,
      ...(reference.kind === "local" ? ["Kind: local directory"] : []),
      ...(reference.kind === "git" ? ["Kind: git repository"] : []),
      ...(reference.kind === "invalid" && reference.repository ? [`Repository: ${reference.repository}`] : []),
      ...(reference.kind === "git" ? [`Repository: ${reference.repository}`] : []),
      ...(reference.kind === "git" && reference.branch ? [`Branch/ref: ${reference.branch}`] : []),
      ...(reference.kind === "invalid" ? [] : [`Reference root: ${reference.path}`]),
      ...(problem
        ? [`Problem: ${problem}`]
        : [
            "For targeted context, inspect the reference path directly with Read, Glob, and Grep. For broader research, call the task tool with subagent scout and include this reference path.",
          ]),
    ].join("\n")
  }

  const references = createMemo(() =>
    Reference.resolveAll({
      references: ConfigReference.normalize(sync.data.config.reference ?? {}),
      directory: sync.path.directory || process.cwd(),
      worktree: sync.path.worktree || sync.path.directory || process.cwd(),
    }),
  )

  const referenceSearch = createMemo(() => {
    if (!store.visible || store.visible === "/") return
    const { lineRange, baseQuery } = extractLineRange(search())
    const slash = baseQuery.indexOf("/")
    if (slash === -1) return
    const reference = references().find((item) => item.name === baseQuery.slice(0, slash))
    if (!reference || reference.kind === "invalid") return
    return {
      reference,
      query: baseQuery.slice(slash + 1),
      lineRange,
    }
  })

  const [files] = createResource(
    () => search(),
    async (query) => {
      if (!store.visible || store.visible === "/") return []
      if (referenceSearch()) return []

      const { lineRange, baseQuery } = extractLineRange(query ?? "")

      // Get files from the control plane
      const result = await sdk.client.find.files({ query: baseQuery })

      const options: AutocompleteOption[] = []

      // Add file options
      if (!result.error && result.data) {
        const sortedFiles = result.data.sort((a, b) => {
          const aScore = frecency.getFrecency(a)
          const bScore = frecency.getFrecency(b)
          if (aScore !== bScore) return bScore - aScore
          const aDepth = a.split("/").length
          const bDepth = b.split("/").length
          if (aDepth !== bDepth) return aDepth - bDepth
          return a.localeCompare(b)
        })

        const width = props.anchor().width - 4
        options.push(
          ...sortedFiles.map((item): AutocompleteOption => {
            const filePart = createFilePart(item, lineRange)

            const isDir = item.endsWith("/")
            return {
              display: Locale.truncateMiddle(filePart.filename, width),
              value: filePart.filename,
              isDirectory: isDir,
              path: item,
              onSelect: () => {
                insertPart(filePart.filename, filePart.part)
              },
            }
          }),
        )
      }

      return options
    },
    {
      initialValue: [],
    },
  )

  const [referenceFiles] = createResource(
    () => referenceSearch(),
    async (match) => {
      if (!match) return []

      const result = await sdk.client.find.files({
        directory: match.reference.path,
        query: match.query,
        limit: 50,
      })

      if (result.error || !result.data) return []

      const width = props.anchor().width - 4
      return result.data.map((item): AutocompleteOption => {
        const { filename, part } = createReferenceFilePart({
          alias: match.reference.name,
          root: match.reference.path,
          item,
          lineRange: match.lineRange,
        })
        return {
          display: Locale.truncateMiddle(filename, width),
          value: filename,
          isDirectory: item.endsWith("/"),
          path: filename,
          onSelect: () => {
            insertPart(filename, part)
          },
        }
      })
    },
    {
      initialValue: [],
    },
  )

  const referenceAliases = createMemo(() =>
    references().map(
      (reference): AutocompleteOption => ({
        display: "@" + reference.name,
        description: reference.kind === "invalid" ? reference.message : " configured reference",
        onSelect: () => {
          insertPart(reference.name, {
            type: "text",
            text: referencePromptText(reference),
            synthetic: true,
          })
        },
      }),
    ),
  )

  const commands = createMemo((): AutocompleteOption[] => {
    const results: AutocompleteOption[] = [...slashes()]

    for (const serverCommand of sync.data.command) {
      if (serverCommand.source === "skill") continue
      results.push({
        display: "/" + serverCommand.name,
        description: serverCommand.description,
        onSelect: () => {
          const newText = "/" + serverCommand.name + " "
          const cursor = props.input().logicalCursor
          props.input().deleteRange(0, 0, cursor.row, cursor.col)
          props.input().insertText(newText)
          props.input().cursorOffset = Bun.stringWidth(newText)
        },
      })
    }

    results.sort((a, b) => a.display.localeCompare(b.display))

    const max = firstBy(results, [(x) => x.display.length, "desc"])?.display.length
    if (!max) return results
    return results.map((item) => ({
      ...item,
      display: item.display.padEnd(max + 2),
    }))
  })

  const options = createMemo((prev: AutocompleteOption[] | undefined) => {
    const filesValue = files()
    const referenceFilesValue = referenceFiles()
    const referenceSearchValue = referenceSearch()
    const referenceAliasesValue = referenceAliases()
    const commandsValue = commands()

    const mixed: AutocompleteOption[] =
      store.visible === "@"
        ? referenceSearchValue
          ? referenceFilesValue || []
          : [...referenceAliasesValue, ...(filesValue || [])]
        : [...commandsValue]

    const searchValue = search()

    if (!searchValue) {
      return mixed
    }

    if ((files.loading || referenceFiles.loading) && prev && prev.length > 0) {
      return prev
    }

    const result = fuzzysort.go(removeLineRange(searchValue), mixed, {
      keys: [
        (obj) => removeLineRange((obj.value ?? obj.display).trimEnd()),
        "description",
        (obj) => obj.aliases?.join(" ") ?? "",
      ],
      limit: 10,
      scoreFn: (objResults) => {
        const displayResult = objResults[0]
        let score = objResults.score
        if (displayResult && displayResult.target.startsWith(store.visible + searchValue)) {
          score *= 2
        }
        const frecencyScore = objResults.obj.path ? frecency.getFrecency(objResults.obj.path) : 0
        return score * (1 + frecencyScore)
      },
    })

    return result.map((arr) => arr.obj)
  })

  createEffect(() => {
    filter()
    setStore("selected", 0)
  })

  function move(direction: -1 | 1) {
    if (!store.visible) return
    if (!options().length) return
    let next = store.selected + direction
    if (next < 0) next = options().length - 1
    if (next >= options().length) next = 0
    moveTo(next)
  }

  function moveTo(next: number) {
    setStore("selected", next)
    if (!scroll) return
    const viewportHeight = Math.min(height(), options().length)
    const scrollBottom = scroll.scrollTop + viewportHeight
    if (next < scroll.scrollTop) {
      scroll.scrollBy(next - scroll.scrollTop)
    } else if (next + 1 > scrollBottom) {
      scroll.scrollBy(next + 1 - scrollBottom)
    }
  }

  function select() {
    const selected = options()[store.selected]
    if (!selected) return
    hide()
    selected.onSelect?.()
  }

  function expandDirectory() {
    const selected = options()[store.selected]
    if (!selected) return

    const input = props.input()
    const currentCursorOffset = input.cursorOffset

    const displayText = (selected.value ?? selected.display).trimEnd()
    const path = displayText.startsWith("@") ? displayText.slice(1) : displayText

    input.cursorOffset = store.index
    const startCursor = input.logicalCursor
    input.cursorOffset = currentCursorOffset
    const endCursor = input.logicalCursor

    input.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)
    input.insertText("@" + path)

    setStore("selected", 0)
  }

  useBindings(() => ({
    target: props.input,
    enabled: () => Boolean(store.visible),
    commands: [
      {
        name: "prompt.autocomplete.prev",
        title: "Previous autocomplete item",
        category: "Autocomplete",
        run() {
          setStore("input", "keyboard")
          move(-1)
        },
      },
      {
        name: "prompt.autocomplete.next",
        title: "Next autocomplete item",
        category: "Autocomplete",
        run() {
          setStore("input", "keyboard")
          move(1)
        },
      },
      {
        name: "prompt.autocomplete.hide",
        title: "Hide autocomplete",
        category: "Autocomplete",
        run() {
          hide()
        },
      },
      {
        name: "prompt.autocomplete.select",
        title: "Select autocomplete item",
        category: "Autocomplete",
        run() {
          select()
        },
      },
      {
        name: "prompt.autocomplete.complete",
        title: "Complete autocomplete item",
        category: "Autocomplete",
        run() {
          const selected = options()[store.selected]
          if (selected?.isDirectory) {
            expandDirectory()
            return
          }

          select()
        },
      },
    ],
    bindings: tuiConfig.keybinds.gather("prompt.autocomplete", [
      "prompt.autocomplete.prev",
      "prompt.autocomplete.next",
      "prompt.autocomplete.hide",
      "prompt.autocomplete.select",
      "prompt.autocomplete.complete",
    ]),
  }))

  function show(mode: "@" | "/") {
    setStore({
      visible: mode,
      index: props.input().cursorOffset,
    })
  }

  function hide() {
    const text = props.input().plainText
    if (store.visible === "/" && !text.endsWith(" ") && text.startsWith("/")) {
      const cursor = props.input().logicalCursor
      props.input().deleteRange(0, 0, cursor.row, cursor.col)
      // Sync the prompt store immediately since onContentChange is async
      props.setPrompt((draft) => {
        draft.input = props.input().plainText
      })
    }
    setStore("visible", false)
  }

  onMount(() => {
    props.ref({
      get visible() {
        return store.visible
      },
      onInput(value) {
        if (store.visible) {
          if (
            // Typed text before the trigger
            props.input().cursorOffset <= store.index ||
            // There is a space between the trigger and the cursor
            props.input().getTextRange(store.index, props.input().cursorOffset).match(/\s/) ||
            // "/<command>" is not the sole content
            (store.visible === "/" && value.match(/^\S+\s+\S+\s*$/))
          ) {
            hide()
          }
          return
        }

        // Check if autocomplete should reopen (e.g., after backspace deleted a space)
        const offset = props.input().cursorOffset
        if (offset === 0) return

        // Check for "/" at position 0 - reopen slash commands
        if (value.startsWith("/") && !value.slice(0, offset).match(/\s/)) {
          show("/")
          setStore("index", 0)
          return
        }

        // Check for "@" trigger - find the nearest "@" before cursor with no whitespace between
        const idx = mentionTriggerIndex(value, offset)
        if (idx !== undefined) {
          show("@")
          setStore("index", idx)
        }
      },
    })
  })

  const height = createMemo(() => {
    const count = options().length || 1
    if (!store.visible) return Math.min(10, count)
    positionTick()
    return Math.min(10, count, Math.max(1, props.anchor().y))
  })

  let scroll: ScrollBoxRenderable
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  return (
    <box
      visible={store.visible !== false}
      position="absolute"
      top={position().y - height()}
      left={position().x}
      width={position().width}
      zIndex={PROMPT_OVERLAY_Z_INDEX}
      {...SplitBorder}
      borderColor={theme.border}
    >
      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scroll = r)}
        backgroundColor={theme.backgroundMenu}
        height={height()}
        scrollbarOptions={{ visible: false }}
        scrollAcceleration={scrollAcceleration()}
      >
        <Index
          each={options()}
          fallback={
            <box paddingLeft={1} paddingRight={1}>
              <text fg={theme.textMuted}>No matching items</text>
            </box>
          }
        >
          {(option, index) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={index === store.selected ? theme.primary : undefined}
              flexDirection="row"
              onMouseMove={() => {
                setStore("input", "mouse")
              }}
              onMouseOver={() => {
                if (store.input !== "mouse") return
                moveTo(index)
              }}
              onMouseDown={() => {
                setStore("input", "mouse")
                moveTo(index)
              }}
              onMouseUp={() => select()}
            >
              <text fg={index === store.selected ? selectedForeground(theme) : theme.text} flexShrink={0}>
                {option().display}
              </text>
              <Show when={option().description}>
                <text fg={index === store.selected ? selectedForeground(theme) : theme.textMuted} wrapMode="none">
                  {option().description}
                </text>
              </Show>
            </box>
          )}
        </Index>
      </scrollbox>
    </box>
  )
}
