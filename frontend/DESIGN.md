# Design system: Smart Project Allocation

Derived with the UI/UX Pro Max skill (`.claude/skills/ui-ux-pro-max`). Its suggestions were checked against our users and only the parts that fit were kept. The users are adult ITI trainees (often on phones) and programme staff (desktop, data-heavy).

- **Style:** Minimalism / Swiss for enterprise dashboards, with one signature element: the **automation pipeline** (n8n-style connected nodes on a dot-grid canvas). Light, grid-based, high contrast, one primary action per screen, with a light layer of **glass and depth**: panels are frosted glass (translucent `surface` + backdrop blur) over a soft four-colour mesh background; cards and buttons carry a top highlight and a tinted ambient shadow (`shadow-card`, `shadow-raised`, `shadow-btn`); icon tiles use `tile-3d`; link cards and pipeline nodes lift slightly on hover. The skill's default for this product type (dark glassmorphism) was rejected: it reads as a crypto/devtool console, not a skills-programme tool, and it costs contrast for phone users outdoors.
- **Colour:** tokens live in `src/index.css` (`@theme`).
  - `primary` is deep navy-blue #1D4F91 (8.2:1 on white), used for actions and the active state. `chrome` (#0E1F3A) is the sidebar.
  - `accent` is teal #0F766E (5.5:1 on white). It means **automation is moving**: running pipeline stages, flowing connectors, AI-assisted moments. Do not use it for decoration.
  - `clay` (#C4623F) and `violet` (#6247B8), each with `-soft` and `-ink`, add warmth to decoration and data (icon tiles, the background mesh, chart series). They never carry status.
  - Neutrals are cool slate. `surface` / `surface-2` are translucent; floating layers (dialogs, toasts) use `surface-strong`. Status colours are `success`, `warning`, `danger` and `info`, each with a `*-bg` variant.
  - `chart-1..5` are the data series.
  - **Never** use raw hex or Tailwind palette colours (`blue-600`, `gray-500` and so on) in components. Use the tokens: `bg-surface`, `text-muted`, `border-border` and the rest.
- **Type:** IBM Plex Sans for headings and body (`font-heading` / `font-sans`; headings are 600 with slight negative tracking) and IBM Plex Mono (`font-mono`) for codes, run times and pipeline metrics.
  - Scale: page title 1.75rem, section 1rem semibold, body 0.875–1rem, meta 0.75rem.
  - Numbers in tables and KPIs use `tabular-nums`.
- **Icons:** Phosphor (`@phosphor-icons/react`) only, 16–20px, `aria-hidden` when next to visible text. No emoji or Unicode glyphs as icons.
- **Surfaces:**
  - Cards are `rounded-xl border border-border bg-surface shadow-card`, with a 20px padding (`p-5`).
  - Page gap is `space-y-6`; grid gaps are `gap-4`, or `gap-6` between sections.
- **Status:** never rely on colour alone. StatusBadge has a dot plus text, and meters show the numbers.

## Components (import from `@/components/ui` and `@/components/shared`)

| Need | Use |
|---|---|
| Page title + actions | `PageHeader` (`eyebrow` slot takes `<BackLink to>`) |
| Section | `Card` (`title`, `description`, `icon`, `actions`, `flush` for edge-to-edge tables) |
| KPI | `StatCard` (`label`, `value`, `hint`, `icon`, `tone`, `to`) in `grid gap-4 sm:grid-cols-2 xl:grid-cols-4` |
| Proportion | `StackedBar` (segments + legend with numbers) |
| Fill / capacity / rate | `Meter` |
| Score 0–100 | `ScoreBar` (`tone="auto"` colours by band) |
| Journey | `Steps` |
| Donut / histogram | `Donut`, `Histogram` (`@/components/shared/Charts`): text summary + legend with numbers |
| Animated number | `CountUp` (StatCard uses it for numeric values; screen readers get only the final value) |
| Automated lifecycle | `Pipeline` (`@/components/shared/Pipeline`): stages with `status` (`done` / `active` / `waiting` / `attention` / `error` / `idle`), metric, detail rows and a link. Status is always text + icon, never colour alone. Every status must be derived from API data. |
| Person | `Avatar` + the visible name |
| Buttons | `Button` variants `primary` / `secondary` / `ghost` / `danger` / `accent`, sizes `sm` / `md` / `lg`, `icon` prop for a leading icon |
| Lists of records | `DataTable` (sortable headers, aria-sort) + `Pagination` |
| States | `LoadingState` (skeleton), `EmptyState` (`icon`, `action`), `ErrorState`, `Alert` (`icon`) |
| Forms | `FormField` + `Input` / `Select` / `Textarea`; `FormError` at the top |
| Modals | `Dialog` (`description`, `size="lg"`), `ConfirmDialog` |

## Layout rules

- **Mobile first.** No horizontal page scroll at 375px; only tables scroll inside their card. Filter bars wrap.
- **Content width:** the shell caps it at `max-w-7xl`. Long text has a max width of about 70 characters (`max-w-3xl`).
- **Touch targets:** at least 40px high (the inputs are 44px on mobile).
- **Focus:** the global `:focus-visible` ring must stay. Never remove outlines.
- **Themes:** light and dark. Dark follows the system setting; the header toggle stores an override (`data-theme` on `<html>`). In dark, `text-primary` / `text-accent` map to their light ink shades for contrast.
- **Tables:** `DataTable` renders a table from md up and one card per row on phones (first column = card title, sortable columns become chips).
- **Motion:** 150–200ms colour/opacity transitions. The only looping motion is the pipeline: a dash flow on connectors into an `active` stage and a soft pulse on `waiting` dots. A refresh that changes a stage flashes that node once and pulses its incoming connector; pages fade in on route change; skeletons shimmer. All stop under `prefers-reduced-motion` (respected globally).
