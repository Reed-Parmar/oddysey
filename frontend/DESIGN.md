# Design system: Smart Project Allocation

Derived with the UI/UX Pro Max skill (`.claude/skills/ui-ux-pro-max`). Its suggestions were checked against our users and only the parts that fit were kept. The users are adult ITI trainees (often on phones) and programme staff (desktop, data-heavy).

- **Style:** Minimalism / Swiss for enterprise dashboards. Light, grid-based, high contrast, little decoration, one primary action per screen.
- **Colour:** tokens live in `src/index.css` (`@theme`).
  - `primary` is indigo #4F46E5 (6.3:1 on white), used for actions and the active state.
  - `accent` is orange #EA580C, used sparingly for AI or highlight moments.
  - Neutrals are slate. Status colours are `success`, `warning`, `danger` and `info`, each with a `*-bg` variant.
  - `chart-1..5` are the data series.
  - **Never** use raw hex or Tailwind palette colours (`blue-600`, `gray-500` and so on) in components. Use the tokens: `bg-surface`, `text-muted`, `border-border` and the rest.
- **Type:** Lexend for headings (`font-heading`, applied to h1–h4 automatically) and Source Sans 3 for body text (`font-sans`).
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
- **Motion:** 150–200ms colour/opacity transitions only; `prefers-reduced-motion` is respected globally.
