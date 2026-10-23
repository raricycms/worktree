# Interface stance

This is the implementation note for the web frontend: what the interface
believes, which class carries which job, and what a change has to keep true.
It is the map, not the territory — the numbers live in
`frontend/web/src/styles/tokens.css`, the rules in
`frontend/web/src/styles/components.css`.

## The one belief

**Visuals are encoding, not decoration.** Every visible property (surface,
shape, colour, motion, weight) must carry exactly one message the user needs:
"this is clickable", "this block matters more", "this just happened". A style
that cannot say what it encodes is suspect; it may still exist as character,
but it must admit it is not information.

## Surface carries hierarchy; lines never do

Three tones: page (`--paper`) → card (`--card`) → inside a card (`--inset`).
`--raised` is not a fourth hierarchy step: it is the surface of something
floating above the page (a toast). Borders and shadows are not hierarchy tools.
A line is allowed only when it draws a *state* (focus) or a *scale* (calendar
hour grid, inline marks). There are three shadows: `--glow-lift` (something
lifts: hovered card, overlay), `--glow-focus` (a field is focused) and
`--shadow-float` (a status surface has to read above the page in both themes).
The glow shadows are brand light; `--shadow-float` is neutral because elevation
must work on both paper tones. No other neutral shadows.

## Shape is classification

Pill (`--r-pill`) = a one-line actionable thing. Card (`--r-card`) = a
container. Field (`--r-field`) = a multi-line input or an inner block.
Sub (`--r-sub`) = a secondary row inside a container. Mark (`--r-mark`) =
an inline marker (checkbox, diff swatch). Do not invent radii per page.

Shape also says what a control *does*:

- A **segmented control** is a pill track holding one pill thumb. The thumb is
  the selection; item text only brightens, so hover and selected never both
  light up. Items are equal width by construction — the thumb's geometry is
  computed from the item count, and a content-sized item would desynchronise it.
- An **expander** is a pill at rest and takes the field radius as it opens: a
  one-line control becoming a list. Closing returns it to the pill. The surface
  clips to that moving radius, so its hover tint and rows never paint past the
  edge the user sees.
- A **capsule is for one line of things**. A group that wraps or carries
  several rows (the calendar toolbar) takes the field radius instead.
- A **card clips to its own radius** (`overflow: clip`): a child tint, row or
  glow may never paint outside the rounded corner that contains it.

## State belongs to colour, never to size

Hover, focus, press, error, selected: none of them may change layout.
Use background, colour, shadow, opacity, brightness — properties that do not
participate in layout. No `translateY`, no width/height/padding/border changes
on state. (Caveat: an overlay appearing/disappearing may animate its own
entry; that is a thing appearing, not a state changing size.)

## One form, one meaning

- Red is danger and undo. Green is "done". Yellow is favorite. Brand blue is
  "this site" and only appears as lift or focus. Any other hue is a category
  colour (`--cat-*`): it separates parallel items and carries no judgement.
- Two lit states must never look the same: hover must be visibly different
  from selected/current.
- One tint recipe per state: `--brand-tint` (selected/current),
  `--brand-tint-strong` (selected row / pressed), `--danger-tint`,
  `--success-tint`, `--favorite-tint`.
- Three button tiers only: `.btn` (secondary), `.btn--primary`, `.btn--danger`.
  Severity is a hue, not a fourth tier.

## Expand in place; never pop over

A control whose value comes from a short, fixed list (a language, a theme, a
day count, a filter mode) expands its own options in the page flow. It never
opens a native menu, a floating popover or an overlay: the panel then cannot
escape the viewport or cover the thing it belongs to, it animates in both
directions, and the page keeps its reading order. A long, data-driven list
(nodes a block can link to, a node's move destination) keeps the native
`select` — hundreds of options are a picker, not a disclosure.

## Confirm changes that land out of sight

A button whose effect is not visible where it sits (an applied server URL, a
saved path, a toggled subscription, a cleared cache) raises a **toast**: one
pill above the page that names what was done and leaves on its own. It is status,
not a dialog — it floats over the page and lets clicks through, it never hosts a
control, and it does not replace the page's own in-place feedback. Validation
still reports in place; a toast is for success.

## Motion expresses relation

1. Identity: the same thing changes form (an overlay grows from its trigger).
2. Causality/order: a panel comes from the edge that opened it; content fades
   in `--dur-fade`, shells move `--dur-expand` (420ms).
3. Character: the curves and asymmetry (`--ease-out`, 420ms shell).

Three named gestures carry almost all of it:

- **Unfold**: a panel's height animates with `grid-template-rows: 0fr → 1fr`
  over `--dur-expand`; its content arrives 55ms later (fade + 8px rise) and
  list options follow one beat apart (`--delay-stagger`, 28ms). The panel stays
  mounted while closed and is `inert`, so the collapse animates too.
- **Entry**: a page fades in (`--dur-enter`), its head and cards rise 10px
  (`rise-in`), and settings cards step in reading order.
- **Confirmation**: a toast rises 14px and fades in over 340ms, its check draws
  itself 120ms later, and the toast leaves downward when its time is up. It
  enters from the bottom edge because it speaks for the action just taken.

No infinite decorative animation: nothing moves unless a state change or an
arrival caused it. `prefers-reduced-motion` is handled globally in
`components.css`; do not bypass it.

## Text is functional only

Labels, necessary explanations, status, errors. No mood copy, no slogans, no
subtitle that repeats the title.

## Class map (use these; do not restyle from scratch)

Shell: `.app` `.topbar` `.topbar__inner` `.brand` `.nav` `.nav__item`
`.topbar__actions` `.app__main` `.app__banner` `.skip-link`
Page: `.page-wrap` `.page-head` `.page-head__inner` `.page-title` `.page-meta`
`.page-body` `.page-body--narrow` `.standalone`
Surface: `.card` `.card--quiet` `.section-head` `.section-title`
`.stack` `.stack--lg` `.cluster` `.spacer` `.empty` `.muted` `.small` `.tiny`
`.mono`
Buttons: `.btn` `.btn--primary` `.btn--danger` `.btn--sm` `.btn--xs`
`.btn--icon` `.btn--block` `.btn--link`
Chips: `.pill` `.pill--brand` `.pill--success`
`.notice` `.notice--danger` `.notice--success`
`.notice__title`
Forms: `.field` `.field__label` `.input` `.select` `.textarea` `.input--mono`
`.input--compact` `.check` `.form` `.form__row` `.form__actions` `.form__error`
Segmented: `.segmented` `.segmented__thumb` `.segmented__item`
`.segmented--chips`
Expander: `.expand-select` `.expand-select__toggle` `.expand-select__label`
`.expand-select__chevron` `.expand-select__panel` `.expand-select__clip`
`.expand-select__list` `.expand-select__option`
Tree: `.tree` `.tree__row` `.tree__disclosure` `.tree__disclosure-spacer`
`.tree__guides` `.tree__guide` `.tree__guide--trunk` `.tree__guide--drop`
`.tree__guide--elbow`
`.tree__label-button` `.node-name` `.node-id` `.node-meta` `.node-status`
`.node-note` `.node-match`
Workbench: `.workbench` `.workbench__main` `.workbench__side`
Detail: `.detail` `.detail__head` `.detail__title` `.detail__actions`
`.detail__tabs` `.detail__tab` `.detail__section` `.facts` `.fact__key`
`.fact__value` `.reminder-box` `.reminder-list` `.reminder-item`
Overlays: `.modal` `.modal__panel` `.modal__head`
`.sheet` `.sheet__handle`
Toast: `.toast-viewport` `.toast` `.toast--error` `.toast__icon`
`.toast__glyph` `.toast__glyph--check` `.toast__message`
Calendar: `.cal-page` `.cal-toolbar` `.cal` `.cal__head` `.cal__gutter`
`.cal__dayhead` `.cal__canvas` `.cal__canvas-inner` `.cal__hourline`
`.cal__hourlabel` `.cal__daydivider` `.cal__today` `.cal__now` `.cal-bar`
`.cal-bar__name` `.cal-bar__link` `.rule-list` `.rule-item`
Stats: `.stat-groups` `.stat-grid` `.stat` `.stat__label` `.stat__value`
Settings: `.settings` `.setting` `.setting__label` `.setting__hint`
`.setting__value` `.settings__actions` `.settings__presets` `.server-chip`
`.server-chip__host` `.server-chip__check`
Conflict: `.split` `.branch` `.branch__head` `.branch__ops` `.branch__tree`
`.diff-legend` `.diff-legend__item` `.diff-swatch` `.diff-swatch--only`
`.diff-swatch--changed` `.resolutions`
Auth: `.auth` `.auth__panel` `.auth__brand`
Utilities: `.visually-hidden` `.icon` `.icon--sm`

Page-scoped classes (page layout that is not shared) live in
`src/styles/views-tree.css`, `views-detail.css`, `views-calendar.css` and
`views-content.css`; they may extend the vocabulary but never redefine it.
The tree page owns `.tree-panel__filters`, `.filter-panel`
(`__clip`, `__content`, `__actions`), `.filter-bar__chevron`, `.node-picker__filters`,
the row completion/add affordances (`.tree__complete`, `.tree__check-spacer`,
`.tree__indent`, `.tree__add`, `.tree__add-row`...) and the daily loop
(`.today`, `.today__head`, `.today__row`, `.today__label`, `.today__time`...);
the calendar page owns the sticky `.cal__head` overrides; the settings/detail
pages own their row layout.

## JSX rules

- Do **not** use Tailwind utilities for colour, radius, padding/margin, border,
  font, shadow, transition, or any visual decision. Those belong to the
  semantic classes above.
- Tailwind layout utilities (`flex`, `grid`, `items-center`, `justify-between`,
  `gap-*`, `w-*`, `max-w-*`, `overflow-*`, `hidden`, `md:*`, `max-md:*`) are
  allowed for structure and responsive switches.
- Inline `style` is only for computed geometry (calendar bar position, tree
  indent depth) and for values that must come from data.
- Icons: `components/icons.tsx`, sized with `.icon` / `.icon--sm`; icons are
  `aria-hidden` unless they are the only label.

## Test contract

Behaviour is asserted through roles, accessible names, `data-testid`, and
**semantic data attributes** — never Tailwind class names. The tree row
contract is stable:

- `data-node-id` — node id (on the row wrapper and the label button)
- `data-status="completed" | "open"`
- `data-selected="true" | "false"`
- `data-match="true" | "false"` (a filter is active and this row matches)
- `data-context="true"` (an ancestor shown only as context, dimmed)
- `data-diff="only" | "changed"` (conflict view only)
- `data-depth` — indentation level

Calendar day headers carry `data-today="true"`; calendar bars carry
`data-selected` and `data-completed`.

Controls that moved their meaning into data attributes:

- A `.segmented` track carries `data-count` (2–9 items) and `data-active`
  (0-based index). The thumb's width and offset are computed from them, so
  every segmented control must set both, and its items are `.segmented__item`
  children of that track.
- An expander keeps its page's `data-testid` on the toggle. Its panel is
  always mounted and `inert` while closed, so a test opens the toggle and then
  clicks an option; it asserts `aria-expanded` / `inert` rather than presence.
- The tree filter panel follows the same rule: `data-testid="filter-panel"`,
  always mounted, `inert` while closed.

## Non-negotiables from the repo

- English in code and comments; comments only when the reason is not obvious.
- No type assertions (`as`, `as any`, non-null `!`) in source files.
- Throw, do not swallow: a failure surfaces, it is never silently repaired.
- Every visible number that can change uses `.mono`: tabular digits in
  `--font-data` (Raricy Numeric), where a zero cannot be read as a letter.
