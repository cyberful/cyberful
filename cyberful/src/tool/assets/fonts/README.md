# Bundled report fonts

Cyberful embeds these fonts into generated PDF reports so rendering remains
deterministic and does not discover or download host fonts at runtime.

| File | Upstream | Revision | SHA-256 | License |
| --- | --- | --- | --- | --- |
| `EBGaramond.ttf` | `octaviopardo/EBGaramond12`, `fonts/ttf/EBGaramond-Regular.ttf` | `6d9aff51f8d0f02b21846e2f4db015c75c24a55c` | `2028dc06d3c130b4761693481436a32a8e35ed500bf58c25c53de004106125b8` | SIL OFL 1.1 |
| `EBGaramond-Bold.ttf` | `octaviopardo/EBGaramond12`, `fonts/ttf/EBGaramond-Bold.ttf` | `6d9aff51f8d0f02b21846e2f4db015c75c24a55c` | `0cfed122e51e3fd44ccedaef7637efed6d5bdc4ad89a6117d70241510309a186` | SIL OFL 1.1 |
| `UbuntuMono-Regular.ttf` | `google/fonts`, `ufl/ubuntumono/UbuntuMono-Regular.ttf` | `90abd17b4f97671435798b6147b698aa9087612f` | `b35dd9d2131d5d83a9b87fe9ad22c6288fa3d17688d43302c14da29812417d63` | Ubuntu Font Licence 1.0 |

The complete terms are preserved beside the binaries in
[`EB_GARAMOND_OFL.txt`](EB_GARAMOND_OFL.txt) and
[`UBUNTU_FONT_LICENCE.txt`](UBUNTU_FONT_LICENCE.txt). Do not replace a font
without updating its upstream revision, digest, notice, renderer references,
and the PDF visual regression check.
