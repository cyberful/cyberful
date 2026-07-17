// ── Deferred Startup Indicator ───────────────────────────────────
// Shows cycling dependency messages only when startup outlasts the quiet delay,
//   holds completion briefly, and clears every timer on component cleanup.
// ─────────────────────────────────────────────────────────────────

import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { Spinner } from "./spinner"
import { cyberfulOsDir } from "@/dependency/config"
import { useAnimationsEnabled } from "../context/animation"

const startupMessages = [
  ...(cyberfulOsDir() ? ["Starting the cybersecurity operating system..."] : []),
  "Connecting Cyberful services...",
]

export function StartupLoading(props: { ready: () => boolean }) {
  const theme = useTheme().theme
  const animationsEnabled = useAnimationsEnabled()
  const [show, setShow] = createSignal(false)
  const [index, setIndex] = createSignal(0)
  const text = createMemo(() =>
    props.ready() ? "Finishing startup..." : startupMessages[index() % startupMessages.length],
  )
  let wait: NodeJS.Timeout | undefined
  let hold: NodeJS.Timeout | undefined
  let cycle: NodeJS.Timeout | undefined
  let stamp = 0

  createEffect(() => {
    const animate = animationsEnabled()
    if (props.ready()) {
      if (wait) {
        clearTimeout(wait)
        wait = undefined
      }
      if (cycle) {
        clearInterval(cycle)
        cycle = undefined
      }
      if (!show()) return
      if (hold) return

      const left = 3000 - (Date.now() - stamp)
      if (left <= 0) {
        setShow(false)
        return
      }

      hold = setTimeout(() => {
        hold = undefined
        setShow(false)
      }, left).unref()
      return
    }

    if (hold) {
      clearTimeout(hold)
      hold = undefined
    }
    if (cycle && !animate) {
      clearInterval(cycle)
      cycle = undefined
    }
    if (animate && !cycle) {
      cycle = setInterval(() => setIndex((value) => value + 1), 2200)
      cycle.unref?.()
    }
    if (show()) return
    if (wait) return

    wait = setTimeout(() => {
      wait = undefined
      stamp = Date.now()
      setShow(true)
    }, 500).unref()
  })

  onCleanup(() => {
    if (wait) clearTimeout(wait)
    if (hold) clearTimeout(hold)
    if (cycle) clearInterval(cycle)
  })

  return (
    <Show when={show()}>
      <box position="absolute" zIndex={5000} left={0} right={0} bottom={1} justifyContent="center" alignItems="center">
        <box backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
          <Spinner color={theme.textMuted}>{text()}</Spinner>
        </box>
      </box>
    </Show>
  )
}
