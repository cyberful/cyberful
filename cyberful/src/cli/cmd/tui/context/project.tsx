// ── Active Project Context ───────────────────────────────────────
// Fetches and stores the control plane's current project identity and canonical
//   path set as one batched terminal state update.
// ─────────────────────────────────────────────────────────────────

import { batch } from "solid-js"
import type { Path } from "@/server/client"
import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"

export const { use: useProject, provider: ProjectProvider } = createSimpleContext({
  name: "Project",
  init: () => {
    const sdk = useSDK()

    const defaultPath = {
      home: "",
      state: "",
      config: "",
      worktree: "",
      directory: sdk.directory ?? "",
    } satisfies Path

    const [store, setStore] = createStore<{
      project: { id: string | undefined }
      instance: { path: Path }
    }>({
      project: {
        id: undefined,
      },
      instance: {
        path: defaultPath,
      },
    })

    async function sync() {
      const [path, project] = await Promise.all([sdk.client.path.get(), sdk.client.project.current()])

      batch(() => {
        setStore("instance", "path", reconcile(path.data || defaultPath))
        setStore("project", "id", project.data?.id)
      })
    }

    return {
      data: store,
      project() {
        return store.project.id
      },
      instance: {
        path() {
          return store.instance.path
        },
        directory() {
          return store.instance.path.directory
        },
      },
      sync,
    }
  },
})
