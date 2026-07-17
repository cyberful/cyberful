# ── Nuclei Template Preview Contract ─────────────────────────────────
# Verifies broad template filters return a bounded actionable sample while
# focused filters preserve the full preview a user needs before scanning.
# → mcps/cyberful-os/cyberful_os_mcp.py — implements side-effect-free template listing.
# ─────────────────────────────────────────────────────────────────────

import importlib.util
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cyberful_os_mcp", ROOT / "cyberful_os_mcp.py")
cyberful_os_mcp = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = cyberful_os_mcp
SPEC.loader.exec_module(cyberful_os_mcp)


# ── The Preview Must Stay Compact For A Broad Filter ──────────────────
# A broad nuclei filter can match 1000+ templates. Before the cap, nuclei_templates dumped every path
# (~54KB / 1108 lines for the real corpus), which blew the caller's MCP output cap: the Expert got a
# spilled file it had to read in chunks just to learn "too broad", and then failed to actually scan. These
# tests pin the fix — the list is capped to a sample when large, so the preview stays small and actionable,
# while a properly scoped filter still prints in full.
# ──────────────────────────────────────────────────────────────────────

class RenderTemplateListTest(unittest.TestCase):
    def _paths(self, n: int) -> list[str]:
        return [f"http/cves/2021/CVE-2021-{i:04d}.yaml" for i in range(n)]

    def test_broad_list_is_capped_to_a_sample(self):
        # The count that blew the cap in the field (image 18). The rendered section must be a small,
        # fixed-size sample — NOT one line per template.
        paths = self._paths(1108)
        out = cyberful_os_mcp._render_template_list(paths, count=1108, list_cap=40)
        # header + 40 sampled paths + 1 "narrow it" footer
        self.assertEqual(len(out), 42)
        self.assertTrue(out[0].startswith("templates (first 40 of 1108"))
        # exactly the first 40 real paths are shown, in order
        self.assertEqual(out[1:41], paths[:40])
        # the footer both accounts for the remainder and steers toward a scoped re-preview
        self.assertIn("+1068 more", out[-1])
        self.assertIn("low tens", out[-1])
        # the whole section is tiny — orders of magnitude under the ~54KB that overflowed the cap
        self.assertLess(len("\n".join(out)), 4000)

    def test_scoped_list_prints_in_full(self):
        # A properly scoped filter (the goal) is small enough to show every template it will run.
        paths = self._paths(5)
        out = cyberful_os_mcp._render_template_list(paths, count=5, list_cap=40)
        self.assertEqual(out, ["templates:", *paths])

    def test_at_cap_prints_in_full_over_cap_samples(self):
        # Boundary: exactly list_cap prints in full; one over switches to the capped sample.
        at = cyberful_os_mcp._render_template_list(self._paths(40), count=40, list_cap=40)
        self.assertEqual(at[0], "templates:")
        self.assertEqual(len(at), 41)  # header + 40
        over = cyberful_os_mcp._render_template_list(self._paths(41), count=41, list_cap=40)
        self.assertTrue(over[0].startswith("templates (first 40 of 41"))
        self.assertIn("+1 more", over[-1])

    def test_zero_matches_renders_nothing(self):
        # A 0-match filter carries its own WARNING summary upstream; the list section stays empty.
        self.assertEqual(cyberful_os_mcp._render_template_list([], count=0), [])


if __name__ == "__main__":
    unittest.main()
