# Teti First Launch Design

## 1. Purpose

This document translates the verified Stitch MCP snapshot into the actual Teti product environment: a macOS desktop app with a native notch/island panel, no traditional main window, and no phone-style onboarding.

The first-launch experience should feel like meeting a new local Teti, giving it a name, watching it quietly establish its identity, and seeing it become ready to live in the Mac notch. It must not feel like email setup, server configuration, account registration, or a developer tool.

No implementation code is included here.

## 2. Source Material

Sources inspected:

- Stitch project `1424727004817836290`
- Verified snapshot: `docs/design/teti-first-launch-stitch-reference.md`
- Task brief attached to this Codex request
- Local logo asset: `/Users/macstudio/Documents/MidiMily/teti-site/public/assets/teti-logo-default.png`
- Existing repo code and docs:
  - `apps/desktop/README.md`
  - `core/account/manager.ts`
  - `core/account/lifecycle.ts`
  - `core/account/model.ts`
  - `core/account/storage.ts`
  - `integrations/chatmail/provisioner.ts`
  - `integrations/chatmail/types.ts`
  - `docs/teti-account-lifecycle.md`
  - `docs/chatmail-integration.md`
  - `integrations/chatmail/README.md`

## 3. Product Constraints

- Runtime surface is a macOS notch/island panel.
- First launch occurs entirely inside the expanded notch panel.
- There is no conventional full-screen onboarding, browser page, mobile status bar, bottom tab bar, sidebar, or dashboard.
- The panel should not become a compressed app window.
- The Teti character remains the emotional center.
- Preserve the current square face, small eyes, and track-based movement language.
- Use one focused action per state.
- Hide Chatmail internals from first-time users.
- Existing account, identity, Chatmail, storage, and lifecycle systems should drive behavior.

## 4. Stitch Screen Inventory

Relevant Stitch screens used:

| Stitch screen | Screen ID | Use in product translation |
| --- | --- | --- |
| `Teti Wakes Up` | `f6603fa463354940a06308e0370520a1` | Adapt for initial expanded notch welcome |
| `Asking Owner Name` | `b212a6317948411b89c4e4a12611d00c` | Omit as separate step; product keeps only Teti naming |
| `Owner Name Confirmation` | `0290ffac93444ffa931d8cc5b13f4918` | Omit as separate step |
| `Teti Asks For Name` | `371f3c51f3df4485821af24914e58cbf` | Adapt for Teti naming state |
| `Thinking State` | `3c6381e476804ca2a85d58bdbdc9e72c` | Adapt for identity creation progress |
| `Teti Named` | `664b3311f6e4430dba10c2880848de5d` | Adapt for quiet success |
| `Daily Mode Transition` | `73da317f816b4bafa6f317a753da5116` | Adapt into first idle state after collapse |
| `Error State` | `e4c0d31621b64fb18592d2460ddf9713` | Adapt for validation, retry, and recoverable provisioning errors |
| `Closed Notch State` | `4bc60a00e3644cfaa5f5a8df70649ffe` | Adapt for collapsed notch presence |
| `Hidden Notch State` | `d996a3df6b4c4382805ea6b62e4175a1` | Adapt for displays or moments where Teti should be nearly invisible |
| `Teti Wakes Up` desktop | `8f7d75455714466e9118175f18f5f152` | Reference for expanded island proportions |
| `Naming Teti State` | `d2528d28782b4cc886951248bd6e9f99` | Reference for compact input and loading button |
| `Teti Awakening` | `98d5ed00e2614fba8dfcafad51281894` | Reference only; avoid full desktop scene |
| `Naming Teti Phase` | `a0930c0215594d2e862e1bf084d867c0` | Reference only; reduce technical identity-card framing |
| `AI Identity Node Created` | `718bd6baddb2463fb3fbca3c30993a47` | Replace; too technical and dark for first launch |
| `Teti Permanent Presence` | `ca427fdf65554973bb943189d883a966` | Reference for post-onboarding presence, not setup UI |
| `Shader` | `c369d6287e5740cebef89c32ea32bbc5` / `ae6642f9a793445197d6873c0fcb3a9e` | Adapt only as subtle blue ambient feedback |

## 5. Existing Teti Implementation Summary

The desktop app is currently a placeholder: `apps/desktop/README.md` names the future Tauri desktop client, macOS notch UI, and local runtime. There are no production UI components to reuse yet inside `apps/desktop`.

The lifecycle implementation is more concrete:

- `TetiAccountManager.createTetiAccount()` returns an existing account if one is already stored.
- Automatic onboarding calls `ChatmailProvisioner.createIdentity(displayName)`.
- The display name is required and trimmed, but the current codebase does not define a maximum name length.
- The created local account is saved through `TetiAccountStorage`.
- Discovery registration follows account creation.
- `loadTetiAccount()` reads local storage only and does not contact the network.
- Teti storage explicitly rejects private keys, credentials, passwords, database paths, and local Chatmail internals.
- Chatmail provisioning uses `dcaccount:mail.seep.im` internally through the provisioner, but this should not be shown to the user.

State logic that must remain unchanged:

- Existing account short-circuit on first launch.
- Chatmail identity provisioning ownership by `ChatmailProvisioner`.
- Local metadata saved in `~/.teti/account.json`.
- Discovery registration after identity creation.
- No direct crypto, key, credential, or database handling in UI.

Missing UI states:

- No first-launch notch UI exists yet.
- No provisioning progress phase model exists yet.
- No user-facing retry/recoverable failure taxonomy exists yet.
- No idle notch character state exists in this repo yet.

## 6. Logo Analysis

The local logo asset was inspected directly.

Observed properties:

- Path: `/Users/macstudio/Documents/MidiMily/teti-site/public/assets/teti-logo-default.png`
- Size: `1254 x 1254`
- Alpha channel: none (`hasAlpha: no`)
- Main form: rounded blue robot head with white face opening and two very small dark eyes.
- Shape language: soft geometric robot, rounded-square head, small antenna, restrained character detail.
- Emotional read: friendly, lightweight, clean, not corporate, not cyberpunk.

Palette sampling from the local asset found these dominant non-white color buckets:

- `#4080f0`
- `#3070f0`
- `#4070f0`
- `#6090f0`
- `#90c0f0`
- `#a0c0f0`
- `#001020`
- `#001030`
- `#000020`
- `#d0e0f0`

Logo usage decision:

- Use the logo as a visual-system reference and optional small mark in the first welcome state only.
- Do not show a large logo above every state.
- Do not place the logo in a white square; the file has no transparency.
- Do not let the logo compete with the live Teti character.
- Later onboarding states should represent the logo indirectly through blue highlights, rounded geometry, and small dark eyes.

## 7. Visual Direction

The first-launch UI should move from Stitch's warm glass/mint palette toward a Teti-specific blue technology system:

- clean
- calm
- lightweight
- intelligent
- trustworthy
- local-first
- friendly rather than corporate
- slightly futuristic but not sci-fi dark
- expressive through the Teti character, not decorative UI noise

Use blue for focus, primary action, identity progress, readiness, small glows, and subtle emphasis. Do not flood surfaces with saturated blue.

## 8. Logo-Derived Color System

| Role | Token | Value | Source |
| --- | --- | --- | --- |
| Primary blue | `--teti-blue-primary` | `#4080F0` | Logo-derived |
| Secondary blue | `--teti-blue-secondary` | `#3070F0` | Logo-derived |
| Highlight blue | `--teti-blue-highlight` | `#6090F0` | Logo-derived |
| Soft highlight | `--teti-blue-soft` | `#90C0F0` | Logo-derived |
| Pale blue surface | `--teti-blue-surface` | `#D0E0F0` | Logo-derived |
| Deep eye/navy | `--teti-blue-black` | `#001020` | Logo-derived |
| Deep secondary | `--teti-blue-black-2` | `#001030` | Logo-derived |
| Notch background | `--teti-notch-bg` | `rgba(2, 10, 22, 0.92)` | Logo-derived adaptation |
| Elevated panel | `--teti-panel` | `rgba(248, 251, 255, 0.92)` | Recommended adaptation |
| Low-opacity blue surface | `--teti-blue-wash` | `rgba(64, 128, 240, 0.10)` | Logo-derived adaptation |
| Border | `--teti-border` | `rgba(96, 144, 240, 0.22)` | Logo-derived adaptation |
| Divider | `--teti-divider` | `rgba(0, 16, 32, 0.10)` | Logo-derived adaptation |
| Focus ring | `--teti-focus-ring` | `rgba(64, 128, 240, 0.28)` | Logo-derived adaptation |
| Glow | `--teti-glow` | `rgba(64, 128, 240, 0.24)` | Logo-derived adaptation |
| Progress | `--teti-progress` | `#4080F0` | Logo-derived |
| Active | `--teti-active` | `#3070F0` | Logo-derived |
| Success | `--teti-success` | `#41AD93` | Stitch-derived, restrained use |
| Warning | `--teti-warning` | `#C98A2E` | Recommended adaptation |
| Error | `--teti-error` | `#BA1A1A` | Stitch-derived |
| Primary text | `--teti-text-primary` | `#001020` | Logo-derived |
| Secondary text | `--teti-text-secondary` | `rgba(0, 16, 32, 0.68)` | Logo-derived adaptation |
| Disabled text | `--teti-text-disabled` | `rgba(0, 16, 32, 0.34)` | Recommended adaptation |

## 9. Character Behavior

Preserve:

- square face
- small eyes
- track-based body or movement language
- restrained expression
- cute but not childish
- local digital-being feel

State behaviors:

| State | Character behavior |
| --- | --- |
| Collapsed | Small eyes visible; slow blink; track/body still |
| Hover/activation | Eyes glance toward cursor; slight blue edge glow; no bounce |
| Welcome | Teti wakes with a short blink and gentle posture lift |
| Naming | Eyes look toward input; subtle track/body settling |
| Submitting | Eyes narrow with focus; track/body breathing |
| Creating identity | Gentle breathing, small track movement, blue progress pulse |
| Slow progress | Eyes pause, then blink; copy reassures without technical detail |
| Recoverable error | Eyes tilt or soften; no exaggerated sad emoji |
| Success | Eyes brighten slightly; calm ready posture |
| Idle | Small eyes, occasional blink, compact presence |

Avoid large emoji expressions, human-chat bubbles, bouncing mascot behavior, and mobile game onboarding energy.

## 10. Notch And Island Layout Model

Collapsed state:

- Width: `132-180px`, depending display/notch geometry.
- Height: `30-36px`.
- Position: top center, aligned beneath physical notch when present.
- Content: Teti small face/eyes only, plus optional tiny status glow.
- Background: deep blue-black, not pure black unless OS notch blending requires it.

Hover or activation state:

- Width may expand by `12-24px`.
- Eye opacity increases.
- Glow becomes visible but remains low intensity.
- Cursor may be tracked by eyes within a `2-4px` movement range.

Expanded onboarding state:

- Recommended width: `420px`.
- Minimum width: `360px`.
- Maximum practical width: `460px`.
- Recommended height: `176-236px`.
- Maximum practical height: `280px`.
- No scrolling in normal first-launch states.
- One primary action per state.
- Character and message remain above the input/action.

Safe spacing:

- On a physical-notch display, place the compact brand and toolbar only inside the system-reported
  `auxiliaryTopLeftArea` and `auxiliaryTopRightArea`; reserve the detected notch width plus `12px`
  through the center of the header.
- Center `28px` header controls vertically inside the top safe row. If either auxiliary area is too
  narrow, fall back to placing the complete header `8px` below the notch exclusion region.
- Start connection content `14px` below the safe-top inset and keep header popovers below the
  physical notch.
- Keep `16px` internal horizontal padding minimum.
- Keep character away from clipped rounded corners.

Expanded-panel dismissal:

- A user-invoked connection panel collapses when the Teti panel loses window focus, when the user
  presses Escape, or after `20s` without pointer or keyboard activity.
- Network operations continue safely if the panel collapses; reopening the eye restores the latest
  connection state.
- Incoming approval does not keep the expanded panel permanently above the workspace. A collapsed
  amber indicator remains visible until the request is accepted or rejected.
- First-launch registration and unrecoverable account setup states do not use the connection-panel
  focus-loss dismissal rule.

Displays without physical notch:

- Anchor to top center as a floating island.
- Use the same collapsed dimensions.
- Do not simulate a phone notch.

External displays:

- Anchor to active display top center.
- If menu bar is not on that display, keep a `12px` top inset.
- If the display is narrow or scaled, reduce width before reducing internal readability.

Content clipping and overflow:

- Clip glow and shader layers to the island.
- Text truncates gracefully after two short lines.
- Long names are ellipsized in success/idle states.
- Input remains single-line.

Keyboard focus:

- Expanded panel should capture focus for the name input.
- Return/Enter submits the active primary action.
- Escape collapses only before provisioning starts; during provisioning it should either do nothing or show a safe cancel confirmation if cancellation exists.

Mouse behavior:

- Click collapsed Teti to expand first launch.
- Click outside may collapse only before the user starts provisioning.
- During identity creation, outside click should not discard progress.

Collapse after success:

- Show ready state briefly for `900-1400ms`.
- Contract to collapsed idle Teti.
- Do not navigate to a home screen.

## 11. First-Launch User Flow

Product flow:

1. Existing account check.
2. If account exists, skip first launch and show normal idle presence.
3. If no account exists, show expanded welcome/naming panel.
4. User names Teti.
5. UI calls existing lifecycle to create or bind identity.
6. Progress states are driven by lifecycle events where available.
7. Success confirms name and readiness.
8. Panel collapses into normal Teti idle state.

User-facing phases:

- `preparing`: "Waking up locally..."
- `creatingIdentity`: "Creating Teti's identity..."
- `securingIdentity`: "Securing it on this Mac..."
- `connecting`: "Connecting Teti's presence..."
- `nearlyReady`: "Almost ready..."
- `ready`: "Teti is ready."

Do not show fake percentages. If meaningful backend progress is unavailable, use semantic phases and indeterminate motion.

## 12. Naming State Specification

Headline:

- `Give your Teti a name`

Supporting copy:

- `This is how your Teti will appear on this Mac.`

Text input:

- Placeholder: `Teti name`
- Single-line.
- Autofocused when expanded.
- Uses `--teti-blue-wash` background and blue focus ring.

Character response:

- Eyes glance toward the input on focus.
- Eyes briefly brighten when valid text appears.
- No speech bubble; the panel copy is enough.

Validation:

- Empty: show `Name your Teti to continue.` and shake panel by `3-4px`.
- Too long: the codebase has no current max name-length rule. Do not invent a conflicting runtime rule. Recommended UI soft guidance is `Keep it short enough for the notch.` while the implementation should defer to the actual account/lifecycle validation once defined.
- Duplicate/reserved name: no existing duplicate/reserved-name rule found. If future storage supports multiple local Tetis, show `That name is already used on this Mac.`; otherwise omit this branch for V1.

Character count:

- Do not show a visible counter by default.
- If a future max length exists, show only when within 4 characters of the limit.

Primary action:

- Label: `Continue`
- Icon: forward arrow or compact check.
- Background: `--teti-blue-primary`.
- Hover: `--teti-blue-secondary`.
- Pressed: scale to `0.98`.

Keyboard behavior:

- Return/Enter submits.
- Escape collapses only if no user text or provisioning is in progress.

Transition into identity creation:

- Disable input.
- Primary button changes into a compact progress indicator.
- Teti eyes narrow into focused/progress state.
- Copy changes to identity creation language without showing Chatmail terms.

## 13. Identity Creation State Specification

Visible user-facing model:

| Phase | User copy | Internal driver |
| --- | --- | --- |
| Preparing | `Preparing Teti...` | Existing account check / runtime startup |
| Creating identity | `Creating Teti's identity...` | `ChatmailProvisioner.createIdentity(displayName)` |
| Securing identity | `Securing it on this Mac...` | Chatmail local account/key creation, hidden from user |
| Connecting | `Connecting Teti's presence...` | Discovery registration |
| Nearly ready | `Almost ready...` | Storage save and transition preparation |
| Ready | `Teti is ready.` | Account created and registered |

UI behavior:

- Use a small semantic phase label, not logs.
- Progress indicator is an animated blue pulse or segmented dots.
- Teti breathes gently with track/body movement.
- If a phase takes longer than expected, update copy to `Still working locally...` or `This is taking a little longer than usual.`
- Do not expose address, account id, QR, keys, fingerprint, relay, JSON-RPC, or protocol details.

## 14. Error And Retry States

Error categories:

| Category | Trigger | User-facing copy | Action |
| --- | --- | --- | --- |
| Empty name | Input empty | `Name your Teti to continue.` | Return focus to input |
| Invalid name | Future validation failure | `That name will not fit well in the notch.` | Edit name |
| Slow progress | Provisioning exceeds expected duration but is still active | `Still creating Teti's identity...` | Keep waiting; optional subtle retry not shown yet |
| Recoverable network failure | Registry or relay can retry | `Teti could not finish connecting. Try again?` | `Try again` |
| Provisioning failure | Chatmail identity creation fails | `Teti could not finish setting up. Nothing private was shown or saved here.` | `Try again` |
| Existing account race | Account appears while onboarding | `Teti is already ready on this Mac.` | Collapse to idle |

Visual behavior:

- Error text appears inline below the input or status.
- Teti eyes tilt subtly.
- Border shifts to error color, but include text and icon so color is not the only signal.
- Retry returns to the last safe phase.

## 15. Success And Collapse Behavior

Success message:

- `Hi, I'm {name}. I'm ready on this Mac.`

Supporting copy:

- `I'll stay nearby in the notch.`

Character expression:

- Small eyes brighten.
- Gentle blue rim/glow.
- Track/body settles into idle.

Readiness indicator:

- Tiny blue-to-mint status dot with text `Ready`.
- Use green/mint sparingly; the main system remains blue.

Primary completion action:

- `Done`

Auto-collapse:

- After successful creation, show success for `900-1400ms`.
- If the user does nothing, collapse into idle.
- If the user presses `Done`, collapse immediately.

First idle state:

- Collapsed notch Teti with small eyes.
- Optional tiny blue ready pulse fades after first few seconds.
- No home screen navigation.

## 16. Stitch Component Translation Table

| Stitch screen | Screen ID | Component/region | Original intent | Original interaction | Suitability | Decision | Rationale | Notch adaptation | Visual adaptation | State/data dependency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `Closed Notch State` | `4bc60a00e3644cfaa5f5a8df70649ffe` | Closed black notch | Compact dormant presence | Hover expands; click pulses | High | adapt for notch UI | Matches product surface | Use native notch geometry, smaller width range | Deep blue-black instead of generic black | Account existence / idle state |
| `Teti Wakes Up` | `f6603fa463354940a06308e0370520a1` | Welcome copy | First meeting | Button advances | Medium | adapt for notch UI | Good emotional pacing, too mobile in dimensions | Fit within `420 x 220` panel | Logo-blue highlights, real Teti character | No local account |
| `Teti Wakes Up` | `f6603fa463354940a06308e0370520a1` | Background photo | Calm context | Decorative only | Low | omit | Notch panel should not show full desktop photo | No full-screen backdrop | Use panel glow only | None |
| `Teti Wakes Up` | `f6603fa463354940a06308e0370520a1` | Logo/brand moment | Introduce Teti | Static | Medium | adapt for notch UI | Logo can appear once but must not compete | Optional `20-28px` mark | Use existing asset only if cropped/masked safely | Welcome only |
| `Teti Wakes Up` | `f6603fa463354940a06308e0370520a1` | Title | Identify Teti | Static text | Medium | adapt for notch UI | Useful, but title should be compact | Show current Teti name or `Teti` in panel header only | Native typography, blue-black text | Account/name state |
| `Teti Wakes Up` | `f6603fa463354940a06308e0370520a1` | Subtitle/supporting copy | Explain first meeting | Static text | Medium | adapt for notch UI | Helpful if shortened | One short line under headline | Secondary text token | First launch |
| `Teti Wakes Up` | `f6603fa463354940a06308e0370520a1` | Primary button | Move forward | Click advances | High | adapt for notch UI | One primary action matches product | Keep one action, compact height | Logo-blue filled button | Current panel state |
| `Teti Wakes Up` | `f6603fa463354940a06308e0370520a1` | Secondary buttons | Settings/more controls | Icon buttons | Low | omit | First launch should not expose settings or competing actions | Hide during onboarding | None | None |
| `Asking Owner Name` | `b212a6317948411b89c4e4a12611d00c` | Owner name input | Ask user's name | Input and submit | Low | omit | Product brief requires short two-step Teti naming then identity creation | Remove owner-name step | None | None |
| `Owner Name Confirmation` | `0290ffac93444ffa931d8cc5b13f4918` | Owner confirmation | Confirm remembering owner | Auto transition | Low | omit | Adds extra onboarding step not in product logic | Remove | None | None |
| `Teti Asks For Name` | `371f3c51f3df4485821af24914e58cbf` | Teti name input | Name Teti | Text input and submit | High | adapt for notch UI | This is the core product step | Single focused notch input | Blue focus/action tokens | `createTetiAccount({ name })` |
| `Teti Asks For Name` | `371f3c51f3df4485821af24914e58cbf` | Input placeholder | Prompt the name | Passive hint | High | adapt for notch UI | Useful, but should avoid form/register feel | Placeholder `Teti name` | Blue focus ring, neutral text | Input state |
| `Teti Asks For Name` | `371f3c51f3df4485821af24914e58cbf` | Step dots | Mobile onboarding progress | Static progress dots | Low | replace | Avoid mobile step UI | Use subtle phase/status text only | Blue micro indicator | Current phase |
| `Thinking State` | `3c6381e476804ca2a85d58bdbdc9e72c` | Closed eyes + dots | Processing | Indeterminate animation | High | adapt for notch UI | Good nontechnical progress model | Keep compact, no footer bulk | Blue phase pulse | Provisioning lifecycle |
| `Thinking State` | `3c6381e476804ca2a85d58bdbdc9e72c` | `Processing Context` label | Technical-ish progress | Passive status | Medium | replace | "Context" is vague/backend-ish | Use friendly semantic phases | Blue status label | Lifecycle phase |
| `Thinking State` | `3c6381e476804ca2a85d58bdbdc9e72c` | Status labels | Show work underway | Animated status | High | adapt for notch UI | Semantic progress is valuable | Use visible phase text, no percentage | Logo-blue pulse | Provisioning phase |
| `Teti Named` | `664b3311f6e4430dba10c2880848de5d` | Star eyes | Celebration | Particles + button | Medium | adapt for notch UI | Joyful but too celebratory | Use subtle bright eyes, no particle fountain | Blue glow, tiny ready dot | Account created |
| `Teti Named` | `664b3311f6e4430dba10c2880848de5d` | `进入米粒的世界` CTA | Enter app | Button transition | Low | replace | Product should collapse to idle, not enter a world/home | Button label `Done` | Blue primary | Success state |
| `Teti Named` | `664b3311f6e4430dba10c2880848de5d` | Success message | Confirm identity | Passive + CTA | High | adapt for notch UI | Required, but should be quieter | `Hi, I'm {name}. I'm ready on this Mac.` | Blue ready dot, restrained mint success | Account created |
| `Daily Mode Transition` | `73da317f816b4bafa6f317a753da5116` | Four action grid | Normal task mode | View/reply/later/archive | Medium | omit | Not part of first launch | Save for future idle/task UI | None | Post-onboarding only |
| `Daily Mode Transition` | `73da317f816b4bafa6f317a753da5116` | Bottom nav | App navigation | Icon nav | Low | omit | Mobile app pattern, conflicts with notch product | No bottom nav | None | None |
| `Daily Mode Transition` | `73da317f816b4bafa6f317a753da5116` | Footer/nav footprint | Persistent navigation | Icon buttons | Low | omit | Notch idle should not look like app navigation | Collapse to character presence | None | Idle state only |
| `Error State` | `e4c0d31621b64fb18592d2460ddf9713` | Error panel | Validation recovery | Retry button + shake | High | adapt for notch UI | Needed, but copy must fit product states | Inline error in same panel where possible | Blue system plus error accent | Validation/provisioning error |
| `Error State` | `e4c0d31621b64fb18592d2460ddf9713` | Error messages | Explain failure | Retry or refocus | High | adapt for notch UI | Needed for recovery | Keep short and specific | Error accent plus icon/text | Validation or lifecycle error |
| `Shader` | `c369d6287e5740cebef89c32ea32bbc5` | WebGL glow | Ambient energy | Mouse responsive | Medium | adapt for notch UI | Good subtle identity-progress feel if restrained | Clip inside panel, low alpha | Logo-blue glow, no heavy gradient | Progress only |
| `AI Identity Node Created` | `718bd6baddb2463fb3fbca3c30993a47` | Identity card | Technical identity confirmation | Continue | Low | replace | Too technical and dark; exposes "node" framing too strongly | Quiet ready state | Blue ready state | Account created |
| `Naming Teti State` | `d2528d28782b4cc886951248bd6e9f99` | Compact input + spinner | Name and submit | Loading icon then done | High | adapt for notch UI | Useful compact control behavior | Use in naming panel | Logo blue button/focus | Submit lifecycle |
| Desktop mock screens | mixed | Menu bar, dock, desktop icons | Contextual macOS scene | Decorative | Low | omit | Product should be native notch, not fake desktop | Use real OS placement | None | None |
| Desktop mock screens | mixed | Browser frame / page shell | Web preview structure | None | Low | omit | Teti has no browser or main page onboarding | Use Tauri notch window only | None | None |
| Desktop mock screens | mixed | Page header | App/page identity | Static | Low | replace | Notch panel needs compact identity, not page header | Small header row inside panel | Native type, blue-black | Panel state |
| Desktop mock screens | mixed | Decorative graphics | Atmosphere | Passive | Low | omit | Competes with compact character focus | Use only subtle clipped glow | Low-opacity blue | Progress only if useful |
| All mobile screens | mixed | Mobile status bar | Phone context | Static | Low | omit | Product is macOS desktop, not phone | Never render phone chrome | None | None |
| All mobile screens | mixed | Phone/mobile layout assumptions | Mobile app preview | Page-like states | Low | replace | Notch is not a phone viewport | Compact horizontal/stack hybrid | Blue notch surface | All first-launch states |

## 17. Design Tokens

Colors:

| Token | Value | Source |
| --- | --- | --- |
| `color.bg.notch` | `rgba(2, 10, 22, 0.92)` | Logo-derived adaptation |
| `color.bg.panel` | `rgba(248, 251, 255, 0.92)` | Recommended adaptation |
| `color.bg.panelElevated` | `rgba(255, 255, 255, 0.96)` | Recommended adaptation |
| `color.bg.input` | `rgba(64, 128, 240, 0.08)` | Logo-derived adaptation |
| `color.bg.inputFocus` | `rgba(64, 128, 240, 0.13)` | Logo-derived adaptation |
| `color.blue.primary` | `#4080F0` | Logo-derived |
| `color.blue.secondary` | `#3070F0` | Logo-derived |
| `color.blue.highlight` | `#6090F0` | Logo-derived |
| `color.blue.soft` | `#90C0F0` | Logo-derived |
| `color.blue.black` | `#001020` | Logo-derived |
| `color.text.primary` | `#001020` | Logo-derived |
| `color.text.secondary` | `rgba(0, 16, 32, 0.68)` | Recommended adaptation |
| `color.text.disabled` | `rgba(0, 16, 32, 0.34)` | Recommended adaptation |
| `color.border.default` | `rgba(96, 144, 240, 0.22)` | Logo-derived adaptation |
| `color.divider` | `rgba(0, 16, 32, 0.10)` | Recommended adaptation |
| `color.focus.ring` | `rgba(64, 128, 240, 0.28)` | Logo-derived adaptation |
| `color.button.bg` | `#4080F0` | Logo-derived |
| `color.button.hover` | `#3070F0` | Logo-derived |
| `color.button.pressed` | `#2866D8` | Recommended adaptation |
| `color.button.disabled` | `rgba(0, 16, 32, 0.14)` | Recommended adaptation |
| `color.progress` | `#4080F0` | Logo-derived |
| `color.success` | `#41AD93` | Stitch-derived |
| `color.warning` | `#C98A2E` | Recommended adaptation |
| `color.error` | `#BA1A1A` | Stitch-derived |

Radii:

| Token | Value | Source |
| --- | --- | --- |
| `radius.notchCollapsed` | `999px` | Stitch-derived adaptation |
| `radius.panel` | `28px` | Stitch-derived adaptation |
| `radius.input` | `14px` | Recommended adaptation |
| `radius.button` | `999px` | Stitch-derived |
| `radius.small` | `8px` | Stitch-derived |

Spacing:

| Token | Value | Source |
| --- | --- | --- |
| `space.1` | `4px` | Recommended adaptation |
| `space.2` | `8px` | Stitch-derived |
| `space.3` | `12px` | Stitch-derived |
| `space.4` | `16px` | Recommended adaptation |
| `space.5` | `20px` | Stitch-derived |
| `space.6` | `24px` | Recommended adaptation |
| `panel.paddingX` | `18-20px` | Stitch-derived adaptation |
| `panel.paddingY` | `14-18px` | Recommended adaptation |

Shadows:

| Token | Value | Source |
| --- | --- | --- |
| `shadow.panel` | `0 18px 36px rgba(0, 16, 32, 0.18)` | Logo-derived adaptation |
| `shadow.edge` | `0 0 0 0.5px rgba(96, 144, 240, 0.26) inset` | Logo-derived adaptation |
| `shadow.glow` | `0 0 28px rgba(64, 128, 240, 0.22)` | Logo-derived adaptation |
| `shadow.error` | `0 0 0 3px rgba(186, 26, 26, 0.14)` | Stitch-derived adaptation |

Motion:

| Token | Value | Source |
| --- | --- | --- |
| `duration.micro` | `120ms` | Recommended adaptation |
| `duration.fast` | `180ms` | Recommended adaptation |
| `duration.panel` | `360ms` | Stitch-derived adaptation |
| `duration.identityPhase` | `600ms` | Recommended adaptation |
| `duration.successHold` | `900-1400ms` | Recommended adaptation |
| `ease.native` | `cubic-bezier(0.16, 1, 0.3, 1)` | Stitch-derived |
| `ease.springSoft` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Stitch-derived, use sparingly |

## 18. Typography

Use native macOS/system typography where possible:

```css
font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", sans-serif;
```

Stitch used Inter and noted that the rendering should mimic SF Pro. The product should prefer native SF Pro on macOS and keep Inter as a fallback.

Compact notch hierarchy:

| Role | Size | Weight | Line height | Use |
| --- | --- | --- | --- | --- |
| `title` | `15px` | `600` | `20px` | Teti name or short headline |
| `message` | `13px` | `500` | `18px` | Main onboarding message |
| `support` | `12px` | `400` | `16px` | Secondary copy |
| `input` | `13px` | `500` | `18px` | Name entry |
| `button` | `13px` | `600` | `18px` | Primary action |
| `status` | `11px` | `500` | `14px` | Progress and errors |

Avoid oversized mobile onboarding type and long centered paragraphs.

## 19. Motion And Transitions

Recommended transitions:

- Collapsed to expanded: `320-380ms`, native ease, width/height/radius interpolation.
- Hover: `120-180ms`, opacity/glow only.
- Eye blink: every `4-6s`, randomized slightly.
- Eye tracking: `80-120ms` eased transform, max `4px`.
- Submit press: `120ms`, scale `0.98`.
- Error shake: `300-400ms`, max `4px`.
- Progress phase change: `500-700ms`, crossfade text and pulse.
- Success collapse: hold `900-1400ms`, then `360ms` contract.

Reduced motion:

- Disable eye tracking and panel scale.
- Keep opacity changes and static status text.
- Replace breathing animations with a static ready/progress indicator.

## 20. Accessibility

Requirements:

- Maintain contrast of at least 4.5:1 for text where possible.
- Keyboard focus must be visible with `--teti-focus-ring`.
- Return/Enter submits name.
- Escape collapses before provisioning, but does not interrupt active provisioning without a safe cancellation model.
- VoiceOver labels:
  - Collapsed Teti: `Teti, idle`
  - Name input: `Teti name`
  - Progress: `Creating Teti identity`
  - Success: `Teti is ready`
  - Error: read inline error text
- Do not rely on color alone for progress, error, or success.
- Text must remain readable at macOS display scale factors.
- Hit targets should be at least `32 x 32px`; primary action should be closer to `36-44px` high.
- Long names must not resize the panel; truncate in title/success/idle contexts.
- UI copy should survive localization by allowing two short lines, not long paragraphs.

## 21. Existing Component Reuse Plan

Reuse:

- `TetiAccountManager.createTetiAccount()` for first account creation.
- `loadTetiAccount()` for first-launch gating.
- `getTetiStatus()` for post-creation status where useful.
- `ChatmailProvisioner.createIdentity(displayName)` for automatic identity provisioning.
- `FileTetiAccountStorage` and `MemoryTetiAccountStorage` behavior.
- Existing storage privacy guarantees.
- Existing Chatmail adapter/provisioner boundary.
- Existing discovery registration flow.

Adapt visually:

- Future desktop/notch shell under `apps/desktop`.
- Existing Teti character asset/runtime when it lands in the repo.
- Logo blue language into component tokens.

Do not reuse:

- Stitch HTML directly.
- Stitch mobile bottom tabs or progress dots as navigation.
- Desktop mock menu bar/dock/browser/page shells.
- Technical identity-card UI that exposes account internals.

## 22. Intentional Deviations From Stitch

- Remove owner-name collection to preserve the product's short two-step logic.
- Replace mobile viewport assumptions with native notch dimensions.
- Replace warm gray/mint-heavy palette with logo-derived blue.
- Reduce glassmorphism intensity.
- Remove phone-app navigation, bottom tabs, and step navigation.
- Omit fake desktop backgrounds, docks, and menu bars.
- Replace technical identity-card screens with friendly identity-establishment phases.
- Replace large celebration/particles with quiet readiness.
- Preserve current Teti character identity rather than using Stitch's abstract two-dot-only mascot.

## 23. Implementation Risks

- Building a detached web prototype could diverge from Tauri/window constraints.
- Copying Stitch HTML would import mobile and full-page assumptions.
- Surfacing Chatmail internals would make onboarding feel like email/crypto setup.
- Replacing lifecycle logic to match UI phases would risk account correctness.
- Using the logo PNG directly in panel states may show a white square because the asset has no alpha.
- A `400px` island may overflow beneath some notch/display combinations unless width is adaptive.
- Long names can break compact notch layout unless truncation is planned.
- Progress phases may look fake if they are timer-only and not connected to lifecycle events.
- A dark cyber/security visual style would conflict with the friendly blue logo.

## 24. Recommended Implementation Sequence

1. Add first-launch UI state model in the desktop layer: `collapsed`, `welcome`, `naming`, `creatingIdentity`, `slowProgress`, `recoverableError`, `failure`, `success`, `idle`.
2. Connect first-launch gating to `loadTetiAccount()`.
3. Build the native notch panel shell with collapsed and expanded dimensions.
4. Add reusable Teti character component with small-eye expression variants.
5. Add naming state and validation using current lifecycle constraints.
6. Wire submit to `createTetiAccount({ name })`.
7. Map lifecycle/provisioner events to semantic progress phases; use indeterminate phases where no granular events exist.
8. Add retry and failure recovery without exposing Chatmail details.
9. Add success state and auto-collapse into idle.
10. Add reduced-motion, VoiceOver, keyboard, display-scale, and long-name checks.
11. Only after behavior is correct, refine blue tokens and glow intensity.

## 25. Acceptance Criteria

- The local logo asset was inspected: yes.
- Logo-derived blue palette is documented.
- Stitch project ID is explicitly listed: `1424727004817836290`.
- Relevant Stitch screen IDs are listed.
- Mobile and web assumptions are explicitly removed.
- Every relevant Stitch component category has a translation decision.
- The current Teti character remains the emotional center.
- Two-step onboarding logic remains intact: name Teti, then create/bind identity.
- Chatmail internals remain hidden from first-time users.
- The design fits a native macOS notch panel.
- Success returns naturally to normal Teti idle state.
- Existing architecture and lifecycle logic are respected.
- No production implementation code is written.
- No Stitch project changes are required.
- No separate web demo is proposed.
