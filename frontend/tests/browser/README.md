# Review workspace browser regression

Start Vite on port 5173 with `npm run dev`, then run `node tests/browser/review.cjs`
from the frontend directory with Playwright available (locally or through `NODE_PATH`).
The default browser is installed Chrome; set `BROWSER_CHANNEL` to choose another channel.

The fixture mounts the real proofreading and arbitration views with a memory router.
All API requests are intercepted and answered with synthetic records and an embedded
sample PDF; no backend data is read or written. Checks cover desktop keyboard placement,
mobile character insertion, pinned keyboard, mobile group switching, field navigation and overview.
Regression scenarios focus the third field on desktop, switch to mobile, replace its selection,
restore another field's remembered caret, ignore delayed events from hidden fields, and repeat
the desktop/mobile transition for both views. The mock uses the restricted task PDF endpoint
and checks source-page mapping instead of requesting original file URLs. Screenshots are written to `/tmp/review-*.png` for visual inspection.

Native iOS/Android keyboard behavior still requires device testing; desktop viewport
emulation cannot verify the operating system's keyboard or IME.

Run `node tests/browser/modal.cjs` against the same Vite server for submission
confirmation regression coverage. It mounts both real review views with synthetic
API responses and checks desktop/mobile Tab and Shift+Tab loops (eight presses
each), Escape/cancel/backdrop dismissal, background scroll locking, focus return
to each trigger, and arbitration's unresolved-field gate. It also verifies that
reviewing and dismissing never submits a record. Screenshots of both dialogs and
the restored trigger are saved in `output/playwright/modal` at the repository root.
Set `MODAL_SCREENSHOTS` to change this directory, `REVIEW_BASE_URL` to change the
server URL, or `BROWSER_CHANNEL=msedge` to use installed Edge on Windows.

The suite also loads the real shipped preset in desktop/mobile proofreading and
arbitration: an exact combining tilde, its dotted-circle label, and both tortoise
shell brackets are inserted at the saved caret. Synthetic screenshots are saved
to `/tmp/keyboard-symbols-*.png`.

Regrouping checks assert the 24-key initial group, a deduplicated total, identical
shortcut/category insertion, cross-group selection replacement, reachability of
all categories and complete pinyin insertion. The default layouts are captured
with synthetic data in `/tmp/keyboard-default-*.png`.
