# Teti First-Launch Stitch Reference

Read-only design snapshot from Stitch project `1424727004817836290`.

Captured on 2026-07-14 via read-only Stitch MCP calls: `get_project`, `list_screens`, `list_design_systems`, and `get_screen`. This document records observed design facts for the first-launch flow that creates a new Teti. It does not define implementation requirements, and it does not modify production UI.

## Scope

### Stitch facts

- Project title: `Teti`
- Project type: `TEXT_TO_UI_PRO`
- Project device type: `MOBILE`
- Project origin: `STITCH`
- First-launch related screens exist in both mobile dynamic-island form and desktop/notch concept form.
- The mobile canvas instances are `390 x 884`. Several screen records export at `780 x 1768`, which appears to be a 2x render of the same intended mobile viewport.
- One mobile screen, `Teti Asks For Name`, exports at `858 x 2122` while using the same `400px` island width in HTML.
- Desktop concept screens use `1280 x 1024` canvas instances and/or `2560 x 2048` exported screen records.

### Out of scope

- No UI implementation.
- No production file changes.
- No behavior contract beyond what the Stitch artifacts imply.

## Screen Hierarchy

### Stitch facts

Primary mobile first-launch flow:

1. `Teti Wakes Up` (`f6603fa463354940a06308e0370520a1`)
2. `Asking Owner Name` (`b212a6317948411b89c4e4a12611d00c`)
3. `Owner Name Confirmation` (`0290ffac93444ffa931d8cc5b13f4918`)
4. `Teti Asks For Name` (`371f3c51f3df4485821af24914e58cbf`)
5. `Thinking State` (`3c6381e476804ca2a85d58bdbdc9e72c`)
6. `Teti Named` (`664b3311f6e4430dba10c2880848de5d`)
7. `Daily Mode Transition` (`73da317f816b4bafa6f317a753da5116`)

Validation branch:

- `Error State` (`e4c0d31621b64fb18592d2460ddf9713`)

Related desktop/notch concept screens:

- `Closed Notch State`
- `Hidden Notch State`
- `Teti Wakes Up`
- `Teti Awakening`
- `Naming Teti State`
- `Naming Teti Phase`
- `AI Identity Node Created`
- `Teti Permanent Presence`
- `Shader`

## Layout Model

### Stitch facts

- The core UI is a floating dynamic-island shell.
- Mobile flow island width: `400px`.
- Repeated island minimum height: `160px`.
- Mobile body uses `min-height: max(884px, 100dvh)`.
- Island alignment is centered in the viewport.
- Island surface uses glassmorphism: warm translucent surface color, blur, inner border, and soft shadow.
- Transactional onboarding screens suppress or visually downplay bottom navigation.
- Daily mode restores a floating bottom nav with four icons.

Common hierarchy inside mobile island:

1. Top app bar
2. Teti identity/status dot or face icon
3. Teti eye expression
4. Dialogue copy
5. Input or action button
6. Optional progress dots/status/footer

## Dimensions And Intended Device Type

### Stitch facts

| Screen | Stitch device type | Canvas/export dimensions | Intended device |
| --- | --- | --- | --- |
| `Teti Wakes Up` mobile | `MOBILE` | `780 x 1768`, canvas instance `390 x 884` | Mobile-sized dynamic-island preview |
| `Asking Owner Name` | `MOBILE` | `780 x 1768`, canvas instance `390 x 884` | Mobile-sized dynamic-island preview |
| `Owner Name Confirmation` | `MOBILE` | `780 x 1768`, canvas instance `390 x 884` | Mobile-sized dynamic-island preview |
| `Teti Asks For Name` | `MOBILE` | `858 x 2122`, canvas instance `390 x 884` | Mobile-sized dynamic-island preview |
| `Thinking State` | `MOBILE` | `780 x 1768`, canvas instance `390 x 884` | Mobile-sized dynamic-island preview |
| `Teti Named` | `MOBILE` | `780 x 1768`, canvas instance `390 x 884` | Mobile-sized dynamic-island preview |
| `Daily Mode Transition` | `MOBILE` | `780 x 1768`, canvas instance `390 x 884` | Mobile-sized dynamic-island preview |
| `Error State` | `MOBILE` | `780 x 1768`, canvas instance `390 x 884` | Mobile-sized dynamic-island preview |
| Desktop/notch variants | `DESKTOP` | `1280 x 1024` or `2560 x 2048` | Desktop companion/notch concept |

## Colors

### Stitch facts

Core light palette from the project theme:

| Token | Value |
| --- | --- |
| `surface` | `#fcf9f8` |
| `surface-dim` | `#dcd9d9` |
| `surface-container-lowest` | `#ffffff` |
| `surface-container-low` | `#f6f3f2` |
| `surface-container` | `#f0eded` |
| `surface-container-high` | `#eae7e7` |
| `surface-container-highest` | `#e5e2e1` |
| `on-surface` | `#1b1b1c` |
| `on-surface-variant` | `#434749` |
| `primary` | `#181f21` |
| `primary-container` | `#2d3436` |
| `on-primary` | `#ffffff` |
| `secondary` | `#5e5e62` |
| `secondary-container` | `#e0dfe3` |
| `tertiary` | `#00231b` |
| `tertiary-container` | `#003b2f` |
| `tertiary-fixed` | `#8ef6d8` |
| `tertiary-fixed-dim` | `#71d9bd` |
| `on-tertiary-container` | `#41ad93` |
| `outline` | `#747879` |
| `outline-variant` | `#c3c7c8` |
| `error` | `#ba1a1a` |
| `error-container` | `#ffdad6` |

Observed surface treatments:

- Main island: `rgba(252, 249, 248, 0.8)` or `rgba(252, 249, 248, 0.85)`.
- Page/background simulation: `#f0f0f0`, `#e5e7eb`, `#e2e2e7`, or blurred generated desktop imagery.
- Closed desktop notch: `rgba(0, 0, 0, 0.9)` with white eyes.
- Success mint glow: `#8ef6d8`, `#71d9bd`, `#41ad93`.

## Typography

### Stitch facts

Font family: `Inter`. Project design notes say it should mimic `SF Pro` spacing/rendering.

| Token | Font | Size | Weight | Line height | Letter spacing |
| --- | --- | --- | --- | --- | --- |
| `dialogue-lg` | Inter | `18px` | `600` | `24px` | `-0.02em` |
| `dialogue-md` | Inter | `15px` | `500` | `20px` | `-0.01em` |
| `body-sm` | Inter | `13px` | `400` | `18px` | default |
| `label-caps` | Inter | `11px` | `600` | `14px` | `0.05em` |
| `label-xs` | Inter | `10px` | `500` | `12px` | default |

Observed usage:

- `dialogue-md`: primary spoken copy and main action labels.
- `dialogue-lg`: top-bar identity and success emphasis.
- `body-sm`: secondary explanatory copy.
- `label-xs` / `label-caps`: progress/status labels and compact button labels.

## Spacing Scale

### Stitch facts

Project theme spacing:

| Token | Value |
| --- | --- |
| `island-width` | `400px` |
| `island-min-height` | `160px` |
| `island-max-height` | `180px` |
| `container-padding` | `20px` |
| `element-gap` | `12px` |
| `stack-gap` | `8px` |

Observed additional spacing:

- Header heights: `32px`, `40px`, `48px`, or `56px` depending state.
- Eye gaps: `12px`, `32px`, or `40px` depending expression.
- Input/action gap: `8px` or `12px`.
- Primary button padding: `px-8 py-3`.
- Dock/nav icon gap: `16px`.
- Progress dots: `6px` dots with `8px` gap in owner-name step.

## Corner Radii

### Stitch facts

Project theme radii:

| Token | Value |
| --- | --- |
| `sm` | `0.25rem` |
| `DEFAULT` | `0.5rem` |
| `md` | `0.75rem` |
| `lg` | `1rem` |
| `xl` | `1.5rem` |
| `full` | `9999px` |

Observed radii:

- Main island: `2.5rem` (`40px`).
- Inputs: `rounded-2xl`, `rounded-xl`, or equivalent.
- Primary circular icon buttons: `44 x 44` with full radius.
- Desktop closed notch: `180 x 32`, `border-radius: 16px`.
- Dock: `20px`.
- Dock item: `10px`.

## Shadows And Borders

### Stitch facts

Common island border/shadow:

- Border: `0.5px solid rgba(255, 255, 255, 0.3-0.4)`.
- Main shadow examples:
  - `0 1px 2px rgba(0,0,0,0.05), 0 20px 40px rgba(0,0,0,0.12)`
  - `0 1px 1px rgba(255,255,255,0.4) inset, 0 20px 40px rgba(0,0,0,0.12)`
  - `0 0 0 0.5px rgba(255,255,255,0.3) inset, 0 20px 40px rgba(0,0,0,0.1)`
- Hover/elevated state increases ambient shadow to about `0 24px 48px` or `0 25px 50px`.
- Error state floats with a `float` animation and uses the same glass island treatment.
- Desktop dock shadow: `0 20px 50px rgba(0,0,0,0.2)`.

## Button States

### Stitch facts

Primary action buttons:

- Filled with `primary` and `on-primary`.
- Pill shape with full radius.
- Hover examples:
  - `hover:opacity-90`
  - `hover:shadow-lg hover:shadow-primary/20`
  - `group-hover:translate-x-0.5` on arrow icon.
- Active examples:
  - `active:scale-95`
  - `active:scale-90`
  - `active:scale-[0.98]`
- Success submit state:
  - Button icon becomes `progress_activity`, `refresh`, or an animated spinner.
  - After roughly `800ms`, icon becomes `done_all`.
  - Some success states switch from `bg-primary` to `bg-tertiary-container`.
- Error retry button:
  - Full-width primary button, `rounded-2xl`.
  - Icon `replay`.
  - On click, parent island receives `error-shake`.

Secondary/top-bar buttons:

- `more_horiz`, `face_6`, `close`, `bubble_chart`, and `settings`.
- Low-emphasis color: `on-surface-variant` with reduced opacity.
- Hover shifts toward `primary`.

## Input States

### Stitch facts

Owner name input:

- Placeholder: `你的称呼`.
- Default style: translucent surface container, no visible border.
- Focus causes eyes to move down and scale up.
- Input length drives curious eye offsets.
- Empty submit triggers a horizontal shake on the island.

Teti name input:

- Placeholder: `给我取个名字`.
- Default style examples:
  - `rgba(255, 255, 255, 0.4)`
  - `1px solid rgba(0, 0, 0, 0.05)`
- Focus state:
  - Background becomes `rgba(255, 255, 255, 0.7)`.
  - Shadow: `0 0 0 4px rgba(24, 31, 33, 0.05)`.
- Non-empty typing shortens eyes from `24px` to `12px`.
- Successful submit disables/fades the input in one variant.
- Empty or invalid submit routes to `Error State`.

## Progress And Loading States

### Stitch facts

- Owner-name step uses two progress dots: first active, second inactive.
- Teti-name step uses two progress dots: second active.
- Owner confirmation uses a three-dot soft progress hint with the third segment active.
- Thinking/loading state:
  - Copy: `让我记下来…`
  - Closed horizontal eyes.
  - Three animated dots.
  - Footer pill: `Processing Context` with `cloud_upload`.
  - Breathing mint background layer.
- Success state:
  - `check_circle` appears in a mint-tinted circular badge.
  - Soft success flash fades in/out.
  - Auto-transition simulation after `3000ms`.
- Celebration state:
  - Sparkle/particle fountain every `300ms`.
  - Star eyes using Material Symbol `grade`.

## Transitions Implied Between Screens

### Stitch facts

- `Teti Wakes Up` button `认识一下` advances to owner naming.
- Owner name submit advances when input is non-empty; empty input shakes the island.
- Owner confirmation auto-transitions after roughly `3000ms`.
- Teti name submit enters a loading/spinner state, then `Thinking State`.
- `Thinking State` implies async local context persistence.
- `Teti Named` button `进入米粒的世界` advances to normal/daily mode.
- `Daily Mode Transition` represents the post-onboarding companion mode.
- Desktop/notch states imply a collapsed closed notch expanding into a `400px` island.
- Stitch prototype metadata did not expose explicit prototype links for these screens in the retrieved records, so transition ordering is inferred from screen titles, copy, and embedded HTML scripts.

## Teti Eye Expressions

### Stitch facts

| State | Eye treatment |
| --- | --- |
| First wake | Sleepy horizontal pills, `8px x 4px`, blink animation, click briefly opens to `8px` height |
| Owner-name question | Curious circular eyes, `14px x 14px`, large `32px` gap, typing changes offset/scale |
| Owner confirmation | Happy/blushing circular eyes; blush animation shifts from primary to mint |
| Teti-name question | Playful vertical pill eyes, `10px x 24px`, cursor-follow behavior, typing shortens height |
| Thinking | Closed line eyes, `24px x 2px`, subtle `3s` eye-blink |
| Teti named | Sparkly/star eyes via Material Symbol `grade` |
| Error | Confused/sad slanted vertical eyes, one with mint sweat/tear dot |
| Daily mode | Attentive vertical eyes, `8px x 12px`, blink to `2px` height |
| Closed desktop notch | Two `4px` white dots inside a black notch |

## Visual Assets

### Stitch facts

- Google Fonts: Inter.
- Material Symbols Outlined.
- Generated/hosted background images:
  - Serene desktop workspace background for first wake.
  - macOS-style abstract wallpaper for desktop/notch states.
  - Sequoia-inspired abstract wallpaper for naming state variants.
- WebGL shader screens:
  - `Shader` screen at `512 x 512`.
  - Canvas IDs such as `shader-canvas-ANIMATION_11`.
  - Fragment shader comments mention `Teti Mint and soft gradients`.
  - Shader alpha is subtle, e.g. `vec4(finalColor, 0.1)`.
- Desktop environment concept assets:
  - Menu bar.
  - Dock.
  - Finder/Safari/Messages/Mail/Music-style icons.
  - Teti companion app dock icon using two white eye dots.

## Copywriting

### Stitch facts

Observed first-launch copy:

| Screen | Copy |
| --- | --- |
| `Teti Wakes Up` | `你好呀。` / `我是 Teti。` / `第一次见面，我想先认识我的主人。` / `认识一下` |
| `Asking Owner Name` | `你好呀，我该怎么称呼你？` / placeholder `你的称呼` |
| `Owner Name Confirmation` | `好的。` / `记住啦，鹏哥。` |
| `Teti Asks For Name` | `现在轮到我啦。` / `你想怎么称呼我？` / placeholder `给我取个名字` |
| `Thinking State` | `让我记下来…` / `Processing Context` |
| `Teti Named` | `好耶。` / `以后我就是「米粒」啦。` / `进入米粒的世界` |
| `Error State` | `还没有告诉我怎么叫你呢` / `或者... 这个名字有点长啦` / `重试一下` |
| `Daily Mode Transition` | `● 米粒 | 鹏哥的桌面伙伴` / `收到一个新任务` / `需要我帮你处理吗？` / `查看任务` / `回复` / `稍后` / `归档` |

Observed desktop/supporting copy includes:

- `Teti`
- `你好，主人。`
- `第一次见面，给我去个名字吧。`
- `下一步`
- `我的名字`
- `Milo`
- `Serial: TETI-NODE-001-A`
- `Personal AI node`
- `This Mac`
- `Your device`
- `Local first`

## Interaction Intent

### Stitch facts

- Teti is framed as a calm, peripheral desktop companion.
- Interaction is driven by Teti's micro-expression rather than large UI chrome.
- First launch establishes two relationships:
  - How Teti addresses the owner.
  - What the owner names Teti.
- The flow uses small, emotionally expressive confirmations rather than form-heavy onboarding.
- Onboarding suppresses global navigation until setup completes.
- Normal mode introduces task handling with four compact actions.

## Layout Constraints

### Stitch facts

- The island is fixed at `400px` wide even inside mobile-labeled frames with `390px` canvas instances.
- Content should respect the `2.5rem` island radius.
- Internal padding is consistently `20px`.
- The island relies on `overflow: hidden` to clip glass/shader/animation layers.
- Top app bar remains compact and horizontally balanced.
- Background imagery is decorative/contextual and should not compete with the island.
- Bottom navigation is hidden or suppressed in transactional onboarding screens, then restored in daily mode.
- State-specific animation should not resize the shell unexpectedly; most motion occurs through opacity, transform, eye geometry, and shadow.

## Implementation Recommendations

These are recommendations inferred from the Stitch snapshot, not facts retrieved from Stitch:

- Treat `390 x 884` as the target mobile preview size and scale the `400px` island carefully so it does not overflow on narrow runtime surfaces.
- Normalize the owner/Teti sample names before implementation. Stitch mixes `鹏哥`, `米粒`, and `Milo`.
- Preserve the Chinese copy, but review `第一次见面，给我去个名字吧。`; it likely intends `取个名字`.
- Build transitions as explicit state-machine steps rather than relying on timers hidden in components.
- Keep the first implementation scoped to the mobile first-launch flow; use desktop/notch screens as visual direction for later desktop integration.
- Use local assets or generated equivalents for production rather than hotlinking Stitch-hosted image URLs.
- Validate name length and empty input before routing to the error state.
- Prefer one canonical eye component with named variants: `sleepy`, `curious`, `happy`, `playful`, `thinking`, `sparkle`, `sad`, and `attentive`.
