# Teti `0.4.1-beta.1` shared UI and i18n hardening

## Implemented scope

`0.4.1-beta.1` keeps one renderer and one typed catalog pair for macOS and
Windows. M5 adds the shared UI boundary required before installer work:

- the Windows root font stack now selects Segoe UI Variable, Segoe UI,
  Microsoft YaHei UI, Microsoft YaHei, system-ui, and sans-serif in that
  order. Inputs, selects, and text areas inherit the same stack;
- WebView2-oriented layout rules stabilize long English/path wrapping,
  scrollbars, text sizing, transparent-backdrop fallback, and narrow
  companion-window overflow;
- shared accessibility semantics now include consistent `:focus-visible`
  treatment, forced-colors support, reduced-motion scrolling, labelled
  Passport regions, controlled toolbar panels, live Task status, busy state,
  alerts, and real disabled state during connection transitions;
- automatic locale resolution covers `zh-CN`, `zh-TW`, every other primary
  Chinese locale, and non-Chinese operating-system locales. Forced English
  and forced Simplified Chinese override the OS locale in either direction;
- Passport and Codex Usage no longer retain Chinese fallback copy. Technical
  version labels, Agent path placeholders, Osaurus UUID placeholders, and
  provider counts now come from the shared typed catalogs;
- visible-copy validation covers nine presentation surfaces, rejects Han copy
  outside the catalogs, rejects static visible literals, and requires the
  catalog directory to contain only `en.ts` and `zh-hans.ts`;
- Windows continues to expose the existing semantic native codes such as
  `NATIVE_WINDOW_UNAVAILABLE`, `LOCAL_PROFILE_TARGET_INVALID`, and
  `TASK_RESULT_IMAGE_OUTSIDE_SCOPE`. M5 adds no platform-named UI error or
  Windows-only catalog because no new semantic error requires one.

The English local Profile reset wording now says “this device” instead of
“this Mac”, preserving one shared catalog without weakening the exact local
Profile scope.

## Automated and local renderer evidence

The M5 test matrix verifies:

- automatic OS locales `zh-CN`, `zh-TW`, `en-US`, `ja-JP`, and `fr-FR`;
- forced `en` and forced `zh-Hans` over Chinese and non-Chinese OS locales;
- `html.lang` and text direction after locale resolution;
- Windows font, wrapping, scrollbar, backdrop fallback, focus, forced-colors,
  and reduced-motion source contracts;
- toolbar/panel relationships, busy/disabled state, Task live status, and
  alert semantics;
- the exact two-catalog inventory and stable cross-platform native errors.

A local renderer smoke at the real Task companion size of 600×360 covered
Windows-mode English and Simplified Chinese Settings. Both had a 600-pixel
document width with no horizontal overflow, a 360-pixel settings panel with
bounded vertical scrolling, the expected Windows font stack, correctly
labelled controls, keyboard-visible focus on the language select, and a
working forced-English selection.

Mac evidence completed on 2026-08-19: TypeScript typecheck, localized-copy and
icon guards, 711/711 repository tests, 31/31 Mac Rust tests, the Windows x64
Rust target cross-check, production renderer build, and an ad-hoc signed and
verified `0.4.1-beta.1` Mac application at
`apps/desktop/src-tauri/target/release/bundle/macos/Teti.app`. No DMG was
built.

This local renderer smoke is not a WebView2 certification. Automated Mac
evidence can validate the shared DOM/CSS contract, but only the real Wintel
matrix below may close the M5 platform exit gate.

## Real WebView2 exit gate

Use a clean Windows 11 x64 test Profile and the bundled WebView2 environment.
Run each case once at 100% scaling and once on a mixed-DPI second monitor.

1. Launch with primary OS locale `en-US`, `zh-CN`, `zh-TW`, and one
   non-Chinese locale such as `ja-JP`. With language set to Automatic, confirm
   English, Simplified Chinese, Simplified Chinese, and English respectively.
2. On each OS locale, force English and force Chinese. Restart Teti and prove
   the choice persists and overrides the OS locale; return to Automatic and
   prove OS resolution resumes.
3. Inspect Shell, First Launch, update blocker, connections and peer details,
   Passport, Settings, Child Memory, Task Inbox/Composer/Detail, image and
   Artifact actions, authorization, long Task, and delegation states. No text
   may clip, overlap, disappear under a scrollbar, or create horizontal
   scrolling at 100%, 125%, 150%, and 200% scaling.
4. Navigate every interactive control with Tab, Shift+Tab, Enter, Space, and
   Escape. Focus must remain visible, toolbar buttons must announce their
   expanded state and controlled region, and disabled connection transitions
   must not activate.
5. Run Narrator over headings, regions, fields, errors, Task status changes,
   progress, image actions, and destructive local reset confirmation. No raw
   Runtime progress or diagnostic string may be announced as UI copy.
6. Enable Windows High Contrast and Reduce motion. Confirm system colors keep
   controls and focus distinguishable and all nonessential motion is removed.
7. Trigger representative stable errors for Network, exact local Profile
   reset, image scope, Artifact containment, and native window availability.
   Confirm both locales show safe catalog copy and diagnostics retain the
   stable semantic code.

M5 passes only when this matrix has no visible hard-coded copy, no Windows
catalog fork, no horizontal overflow, and no blocking keyboard/Narrator issue.
