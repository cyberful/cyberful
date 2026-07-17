// ── Application Security PDF Report Contracts ───────────────────
// Exercises branded Markdown rendering, workflow-selected artifact paths, safe
//   workarea containment, and the legacy Pentest wrapper's output contract.
// → cyberful/src/tool/security-report-pdf.ts — owns the renderer under test.
// ─────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  renderMarkdownReportToPdf,
  renderReportToPdf,
  stripUnresolvedTemplates,
  type ReportMeta,
} from "./security-report-pdf"

const temporaryDirectories = new Set<string>()

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.add(directory)
  return directory
}

afterEach(async () => {
  const directories = [...temporaryDirectories]
  temporaryDirectories.clear()
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
})

async function render(markdown: string, resolveVars?: (m: string) => string, meta?: ReportMeta) {
  const dir = await temporaryDirectory("cyb-report-test-")
  await writeFile(path.join(dir, "REPORT.md"), markdown)
  const pdf = await renderReportToPdf(dir, resolveVars, meta)
  const bytes = pdf ? (await readFile(pdf)).length : 0
  const reportMd = await readFile(path.join(dir, "REPORT.md"), "utf8")
  return { pdf, bytes, reportMd }
}

describe("renderReportToPdf", () => {
  test("renders a finding with a severity chip and a GFM table to a non-trivial PDF", async () => {
    const md = [
      "# Report",
      "",
      "## F1 - Example finding",
      "Severity: CRITICAL",
      "",
      "| Request | Result | Meaning |",
      "| --- | --- | --- |",
      "| Own object | 200 | baseline |",
      "| Bogus id | 404 | genuine lookup |",
      "",
    ].join("\n")
    const { pdf, bytes } = await render(md)
    expect(pdf).toBeTruthy()
    expect(bytes).toBeGreaterThan(3000)
  })

  test("embeds the redistributable Cyberful fonts without the removed Avenir face", async () => {
    const { pdf } = await render("# Report\n\n## Finding\n\n```text\nevidence\n```\n")
    if (!pdf) throw new Error("Expected the report PDF")
    const contents = (await readFile(pdf)).toString("latin1")
    expect(contents).toContain("EBGaramond-Bold")
    expect(contents).toContain("UbuntuMono-Regular")
    expect(contents).not.toContain("Avenir")
  })

  test("applies the optional {{var}} transform before rendering", async () => {
    let sawTemplate = false
    const { pdf } = await render("# Report\n\napp {{var:target_app_url}}\n", (m) => {
      sawTemplate = m.includes("{{var:target_app_url}}")
      return m.replace("{{var:target_app_url}}", "https://app.example.com")
    })
    expect(pdf).toBeTruthy()
    expect(sawTemplate).toBe(true)
  })

  test("does not truncate a table taller than one page (the old Math.min(180) bug)", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| row ${i} | value ${i} | note ${i} |`).join("\n")
    const md = `# Report\n\n## Big table\n\n| A | B | C |\n| --- | --- | --- |\n${rows}\n`
    const { pdf, bytes } = await render(md)
    expect(pdf).toBeTruthy()
    expect(bytes).toBeGreaterThan(6000)
  })

  test("renders pathological table shapes without throwing", async () => {
    const single = "# Report\n\n| Only |\n| --- |\n| one |\n| two |\n"
    const wide = `# Report\n\n| ${"C1|C2|C3|C4|C5|C6|C7|C8"} |\n| ${"---|---|---|---|---|---|---|---"} |\n| ${"a|b|c|d|e|f|g|h"} |\n`
    expect((await render(single)).pdf).toBeTruthy()
    expect((await render(wide)).pdf).toBeTruthy()
  })

  test("renders the audit-ready sections (document control, coverage matrix, attestation) without throwing", async () => {
    const md = [
      "# Penetration Test Report — Acme",
      "",
      "**Audit-ready penetration test report.** Mapped to SOC 2 and ISO/IEC 27001:2022; not a certification.",
      "",
      "## Document Control",
      "",
      "| Field | Value |",
      "| --- | --- |",
      "| Report version | 1.0 |",
      "| Classification | Confidential |",
      "",
      "## Control mapping",
      "",
      "| Area | SOC 2 | ISO 27001:2022 | Tested | Evidence | Status |",
      "| --- | --- | --- | --- | --- | --- |",
      "| Injection | CC7.1 | A.8.8, A.8.28 | Yes | F-01 | Findings |",
      "| Transport security | CC6.7 | A.8.24 | Yes | — | No exceptions observed |",
      "",
      "## Attestation & independence",
      "",
      "Automated Cyberful workbench assessment. No human reviewer countersignature.",
      "",
    ].join("\n")
    const { pdf, bytes } = await render(md)
    expect(pdf).toBeTruthy()
    expect(bytes).toBeGreaterThan(3000)
  })

  test("applies optional cover metadata (subtitle, target, version, window) without throwing", async () => {
    const meta: ReportMeta = {
      subtitle: "Audit-ready security evidence · SOC 2 · ISO/IEC 27001:2022",
      target: "Acme Corp",
      reportVersion: "1.0",
      engagementWindow: "1 June 2026 to 15 June 2026",
    }
    const { pdf, bytes } = await render("# Report\n\nBody.\n", undefined, meta)
    expect(pdf).toBeTruthy()
    expect(bytes).toBeGreaterThan(1500)
  })

  test("writes the resolved markdown back to REPORT.md so the .md matches the PDF", async () => {
    const { reportMd } = await render("# Report\n\nclient {{var:client_name}}\n", (m) =>
      m.replace("{{var:client_name}}", "Acme Corp"),
    )
    expect(reportMd).not.toContain("{{var:")
    expect(reportMd).toContain("client Acme Corp")
  })

  test("strips an unresolved {{var:...}} from REPORT.md, matching the PDF em dash", async () => {
    const { reportMd } = await render("# Report\n\nclient {{var:client_name}}\n", stripUnresolvedTemplates)
    expect(reportMd).not.toContain("{{var:")
    expect(reportMd).toContain("client —")
  })

  test("leaves REPORT.md byte-identical when no resolver runs (verbatim callers)", async () => {
    const md = "# Report\n\nclient {{var:client_name}}\n"
    const { reportMd } = await render(md)
    expect(reportMd).toBe(md)
  })
})

describe("renderMarkdownReportToPdf", () => {
  test("renders a workflow-selected source to its configured output and resolves the source after success", async () => {
    const workareaCwd = await temporaryDirectory("cyb-code-audit-report-test-")
    const sourcePath = path.join(workareaCwd, "CODE_AUDIT_REPORT.md")
    await writeFile(sourcePath, "# Code Audit\n\nTarget {{var:client_name}}\n")

    const pdfPath = await renderMarkdownReportToPdf({
      workareaCwd,
      sourcePath: "CODE_AUDIT_REPORT.md",
      outputPath: "reports/code-audit-report.pdf",
      resolveVars: (markdown) => markdown.replace("{{var:client_name}}", "Acme"),
      meta: {
        title: "Acme Code Audit",
        subject: "Repository security code audit",
        keywords: ["code audit", "data flow"],
        dateLabel: "16 July 2026",
      },
    })

    expect(pdfPath).toBe(path.join(workareaCwd, "reports", "code-audit-report.pdf"))
    if (!pdfPath) throw new Error("Expected the configured Code Audit PDF")
    expect((await readFile(pdfPath)).length).toBeGreaterThan(1500)
    expect(await readFile(sourcePath, "utf8")).toContain("Target Acme")
  })

  test("returns undefined without creating an output for a missing or empty source", async () => {
    const workareaCwd = await temporaryDirectory("cyb-empty-report-test-")
    const options = {
      workareaCwd,
      sourcePath: "ASSESSMENT_REPORT.md",
      outputPath: "reports/security-assessment.pdf",
    }

    expect(await renderMarkdownReportToPdf(options)).toBeUndefined()
    await writeFile(path.join(workareaCwd, options.sourcePath), "   \n")
    expect(await renderMarkdownReportToPdf(options)).toBeUndefined()
    expect(await Bun.file(path.join(workareaCwd, options.outputPath)).exists()).toBe(false)
  })

  test("rejects artifact paths that escape the workarea or use the wrong document type", async () => {
    const workareaCwd = await temporaryDirectory("cyb-report-path-test-")

    await expect(
      renderMarkdownReportToPdf({
        workareaCwd,
        sourcePath: "../CODE_AUDIT_REPORT.md",
        outputPath: "reports/code-audit-report.pdf",
      }),
    ).rejects.toThrow("sourcePath must stay inside the workarea")
    await expect(
      renderMarkdownReportToPdf({
        workareaCwd,
        sourcePath: "CODE_AUDIT_REPORT.md",
        outputPath: "reports/code-audit-report.txt",
      }),
    ).rejects.toThrow("outputPath must be a relative .pdf path inside the workarea")
  })

  test("does not follow source files or output directories symlinked outside the workarea", async () => {
    if (process.platform === "win32") return
    const workareaCwd = await temporaryDirectory("cyb-report-symlink-test-")
    const outside = await temporaryDirectory("cyb-report-outside-test-")
    await writeFile(path.join(outside, "external.md"), "# External\n")
    await symlink(path.join(outside, "external.md"), path.join(workareaCwd, "CODE_AUDIT_REPORT.md"))

    await expect(
      renderMarkdownReportToPdf({
        workareaCwd,
        sourcePath: "CODE_AUDIT_REPORT.md",
        outputPath: "reports/code-audit-report.pdf",
      }),
    ).rejects.toThrow("sourcePath must be a regular Markdown file")

    await writeFile(path.join(workareaCwd, "ASSESSMENT_REPORT.md"), "# Assessment\n")
    await mkdir(path.join(outside, "reports"))
    await symlink(path.join(outside, "reports"), path.join(workareaCwd, "reports"), "dir")
    await expect(
      renderMarkdownReportToPdf({
        workareaCwd,
        sourcePath: "ASSESSMENT_REPORT.md",
        outputPath: "reports/security-assessment.pdf",
      }),
    ).rejects.toThrow("outputPath resolves outside the workarea")
  })
})

describe("stripUnresolvedTemplates", () => {
  test("replaces a leftover {{var:...}} (including surrounding spaces) with an em dash", () => {
    expect(stripUnresolvedTemplates("client a {{var:client_name}} b")).toBe("client a — b")
    expect(stripUnresolvedTemplates("start {{var: engagement_start }} end")).toBe("start — end")
  })
  test("leaves already-resolved text untouched", () => {
    expect(stripUnresolvedTemplates("Acme Corp, report 1.0")).toBe("Acme Corp, report 1.0")
  })
})
