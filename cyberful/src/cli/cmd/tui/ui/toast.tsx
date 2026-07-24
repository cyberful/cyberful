// ── Validated Toast Notifications ────────────────────────────────
// Decodes bounded toast events, renders one themed notification at a time, and
//   replaces its owned expiry timer whenever a newer message arrives.
// ─────────────────────────────────────────────────────────────────

import { createContext, useContext, type Accessor, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { SplitBorder } from "../component/border"
import { TextAttributes } from "@opentui/core"
import { Schema } from "effect"
import { TuiEvent } from "../event"
import type { TuiThemeCurrent } from "../api-types"

type ToastInput = Schema.Codec.Encoded<typeof TuiEvent.ToastShow.properties>
export type ToastOptions = Schema.Schema.Type<typeof TuiEvent.ToastShow.properties>

const decodeToastOptions = Schema.decodeUnknownSync(TuiEvent.ToastShow.properties)

type ToastTheme = Pick<
  TuiThemeCurrent,
  "backgroundPanel" | "text" | "info" | "success" | "warning" | "error"
>

// ── Stable Notification Surface ──────────────────────────────────
// OpenTUI can apply an async store update after the originating render owner
// has returned. Keeping the renderables mounted lets Solid update only their
// properties instead of creating new computations without a disposable owner.
// Visibility and empty fallbacks preserve the prior absent-toast presentation.
// ─────────────────────────────────────────────────────────────────
export function ToastSurface(props: {
  current: Accessor<ToastOptions | null>
  theme: ToastTheme
  width: Accessor<number>
}) {
  const variant = () => props.current()?.variant ?? "info"
  return (
    <box
      visible={props.current() !== null}
      position="absolute"
      zIndex={4000}
      justifyContent="center"
      alignItems="flex-start"
      top={2}
      right={2}
      maxWidth={Math.min(60, props.width() - 6)}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={props.theme.backgroundPanel}
      borderColor={props.theme[variant()]}
      border={["left", "right"]}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <text
        visible={Boolean(props.current()?.title)}
        attributes={TextAttributes.BOLD}
        marginBottom={1}
        fg={props.theme.text}
      >
        {props.current()?.title ?? ""}
      </text>
      <text fg={props.theme.text} wrapMode="word" width="100%">
        {props.current()?.message ?? ""}
      </text>
    </box>
  )
}

export function Toast() {
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <ToastSurface current={() => toast.currentToast} theme={theme} width={() => dimensions().width} />
  )
}

function init() {
  const [store, setStore] = createStore<{ currentToast: ToastOptions | null }>({
    currentToast: null,
  })

  let timeoutHandle: NodeJS.Timeout | null = null

  const toast = {
    show(options: ToastInput) {
      const toastOptions = decodeToastOptions(options)
      setStore("currentToast", toastOptions)
      if (timeoutHandle) clearTimeout(timeoutHandle)
      timeoutHandle = setTimeout(() => {
        setStore("currentToast", null)
      }, toastOptions.duration).unref()
    },
    error: (err: unknown) => {
      if (err instanceof Error)
        return toast.show({
          variant: "error",
          message: err.message,
        })
      toast.show({
        variant: "error",
        message: "An unknown error has occurred",
      })
    },
    get currentToast(): ToastOptions | null {
      return store.currentToast
    },
  }
  return toast
}

export type ToastContext = ReturnType<typeof init>

const ctx = createContext<ToastContext>()

export function ToastProvider(props: ParentProps) {
  const value = init()
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useToast() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useToast must be used within a ToastProvider")
  }
  return value
}
