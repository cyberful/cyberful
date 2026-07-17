// ── Home Footer Feature ──────────────────────────────────────────
// Registers the application version at the right side of the home footer slot
//   using the public feature API and current terminal theme.
// ─────────────────────────────────────────────────────────────────

import type { TuiFeature, TuiFeatureApi } from "@/cli/cmd/tui/api-types"
import type { InternalTuiFeature } from "../../feature/internal"

const id = "internal:home-footer"

function Version(props: { api: TuiFeatureApi }) {
  const theme = () => props.api.theme.current

  return (
    <box flexShrink={0}>
      <text fg={theme().textMuted}>{props.api.app.version}</text>
    </box>
  )
}

function View(props: { api: TuiFeatureApi }) {
  return (
    <box
      width="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      gap={2}
    >
      <box flexGrow={1} />
      <Version api={props.api} />
    </box>
  )
}

const tui: TuiFeature = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_footer() {
        return <View api={api} />
      },
    },
  })
}

const feature: InternalTuiFeature = {
  id,
  tui,
}

export default feature
