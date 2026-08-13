# Test Users design QA

> **2026-08-13 note:** This document records the original 0.1.0 comparison pass and its screenshots are now historical. The header was since redesigned — a site-identity card (initial badge, project name, address, environment chip, Edit affordance) replaced the `LOCALHOST · <project>` caption, and the scope tabs are now named after the detected project with counts. See `RELEASE_NOTES.md` at the repo root for the current state.

## Evidence

- Source visual truth: `design/login-overlay-reference.png`
- Normalized source content: `design/source-content.png`
- Browser-rendered implementation: `design/implementation-final.png`
- Full-view comparison: `design/comparison-final.png`
- Focused overlay comparison: `design/comparison-overlay-final.png`
- Destructive-action state: `design/site-deletion-confirmation.png`
- Viewport: 1586 × 872 CSS pixels at device scale factor 1
- Source pixels: 1586 × 992; normalized by cropping the 120-pixel browser chrome to a 1586 × 872 page-content image
- Implementation pixels: 1586 × 872
- State: generic local login page, overlay open, current-site tab active, three stored users, first user autofilled, success toast visible

## Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: The final pass uses the same modern system-sans treatment, strong 24-pixel panel title, compact role labels, and clear name/email/note hierarchy. The implementation is marginally denser in secondary text than the generated reference; this is acceptable because the text remains legible and allows real emails and notes to fit without clipping.
- Spacing and layout rhythm: The normalized comparison aligns the login card and extension panel closely with the reference. Panel width, right offset, card heights, dividers, radii, and elevation preserve the intended hierarchy. The added identity row increases the header height slightly and is an intentional product change required by `localhost + page name` recognition.
- Colors and visual tokens: White surfaces, pale neutral page background, indigo primary actions, colored role chips, green success accent, subtle borders, and shadows match the source direction with accessible contrast.
- Image quality and asset fidelity: The target contains no photographic or illustrative assets. All visible controls use vendored Tabler outline icons; no placeholder imagery, emoji, custom inline SVG, or CSS-drawn icons are used. The extension toolbar icon is rasterized from the same icon library.
- Copy and content: The principal source copy is preserved. `LOCALHOST · HikeStrong` and the secondary address replace the mock's address-only label by design, making the agreed site-recognition model explicit.
- Icons and affordances: Search, fill, edit, add, settings, close, lock, and success icons are present and consistent. Edit and close are small functional additions that do not compete with the primary fill action.
- Accessibility and resilience: Controls use semantic buttons, form labels, focus states, reduced-motion handling, constrained panel height, internal scrolling, and a narrow-viewport layout. A separate small-viewport screenshot remains a P3 follow-up; the primary desktop extension surface and the CSS breakpoint behavior are covered, but the browser capture surface did not preserve its temporary compact viewport.

## Primary interactions tested

- Generated a fresh email and 16-character password.
- Saved a user with a role and scenario note.
- Filled email and password fields and displayed the success state.
- Switched between current-site and all-project tabs.
- Opened the site-identity settings and verified `127.0.0.1:4173 + HikeStrong`.
- Collapsed the panel to its launcher and reopened it.
- Confirmed an individual login deletion removes only that login.
- Confirmed whole-site deletion removes the selected identity and all linked logins while preserving other projects.
- Checked the browser console: no warnings or errors.
- Loaded the unpacked extension in an isolated Chrome profile and verified site recognition, generation, `chrome.storage.local` persistence, and autofill end to end.

## Comparison history

1. Initial browser capture: P1 typography mismatch because the shadow-root font did not inherit the intended system-sans stack; primary-button icons also rendered dark.
2. Fix: applied the font stack directly to the shadow root, normalized icon contrast, matched the source panel width/right offset, and aligned the source and implementation to the same page-content viewport.
3. Second comparison: P2 density drift remained in avatar initials and secondary type.
4. Fix: switched avatars to one-letter initials and increased tab, name, email, and note sizes.
5. Final full-view and focused comparisons: no actionable P0/P1/P2 differences remain.

## Follow-up polish

- P3: Capture a dedicated narrow mobile-width image if the overlay is expected to be used frequently in a very small browser window.

## Final result

final result: passed
