# Third-Party Notices

This repository includes third-party software and font assets. Those components
remain subject to their own copyright and license terms; the repository’s AGPL
license does not replace them.

| Component / path | Upstream | Copyright | License | Local modifications |
|---|---|---|---|---|
| `frontend/public/pdfjs/**` | [Mozilla PDF.js / pdfjs-dist 3.11.174](https://github.com/mozilla/pdf.js) | Mozilla and PDF.js contributors; additional notices in the tree | Apache-2.0, with component-specific notices | Packaged runtime distribution and integration configuration |
| `frontend/public/pdfjs/cmaps/**` | Included with PDF.js | Adobe Systems Incorporated and contributors | BSD-style terms in `cmaps/LICENSE` | No license change |
| `frontend/public/pdfjs/standard_fonts/**` | Included with PDF.js | PDFium authors, Google, Red Hat, and identified contributors | BSD-3-Clause for Foxit fonts (`LICENSE_FOXIT`); OFL-1.1 for Liberation fonts (`LICENSE_LIBERATION`) | No license change |
| `frontend/public/fonts/rare-han/**` | [Source Han Sans](https://github.com/adobe-fonts/source-han-sans) and [Plangothic](https://github.com/Fitzgerald-Porthmouth-Koenigsegg/Plangothic_Project) | Adobe and Fitzgerald P. Köenigsegg; see path notices | OFL-1.1 | Renamed, unhinted WOFF2 subsets; reproducible build and hashes documented in the path README |
| `frontend/public/fonts/phonetic/**` | [SIL Charis](https://software.sil.org/charis/) and Source Han Sans | SIL International, Adobe, and identified contributors | OFL-1.1 | Renamed/subset WOFF2 assets; provenance documented in the path README and manifests |

The authoritative notices are the license and README files stored beside each
component. Preserve them when updating or redistributing the assets.

The backend runtime image also installs [Poppler](https://poppler.freedesktop.org/)
(`poppler-utils`, GPL-2.0-or-later) and [libwebp](https://chromium.googlesource.com/webm/libwebp/)
(`libwebp-tools`, BSD-3-Clause) from Alpine packages for private PDF page previews.
They are unmodified external command-line programs; their package licenses and
corresponding sources remain available through the Alpine package repositories.
Generated page images retain the rights and access restrictions of their source
documents, as described in `ASSET_BOUNDARIES.md`.
