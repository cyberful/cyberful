// ── Terminal Border Presets ──────────────────────────────────────
// Defines empty and vertical-split border glyph sets reused by dialog and
//   autocomplete layouts that need stable OpenTUI geometry.
// ─────────────────────────────────────────────────────────────────

export const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

export const SplitBorder = {
  border: ["left" as const, "right" as const],
  customBorderChars: {
    ...EmptyBorder,
    vertical: "┃",
  },
}
