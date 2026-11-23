# Kompas theme (folder `gnd`)

A second interface for Kompas, next to Meadow. It was designed under the
working name GND, which is why the folder, components and CSS classes use
`gnd`; everything people see says Kompas. Both run on the same back end
and data; only the presentation differs.

## Switching

- Settings › System › Interface: Kompas (default) or Meadow. The choice is saved
  per computer and the window reloads.
- For previews, `?theme=kompas` or `?theme=meadow` on the URL overrides it.
- `src/renderer/main.tsx` reads the choice (`presentation/theme.ts`), sets
  `<html data-theme>`, and renders Meadow's `App` or `GndApp`.

## What lives here

- `GndApp`, `GndShell`, `TopNav`, `GndPage`, `destinations.ts`: the GND app
  root, top bar and page router. GND has a Profile page that is also Your
  applications.
- `theme.css`: Space Grotesk and Inter, plus GND values for the shared design
  tokens, applied only under `:root[data-theme='kompas']`. Meadow's tokens in
  `shell.css` are unchanged.
- `gnd.css` and every other stylesheet here use `gnd-` prefixed classes, so
  nothing leaks into Meadow.
- `pages/`: Home, Jobs (search preferences panel, finding roles, job detail),
  Profile and applications, Onboarding (intro music, motion, Ollama setup)
  and the GND Settings frame (its sections are Meadow's, shared).
- `buddy/` (the floating character), `backdrop/` (moving colour fields),
  `audio/` (intro music), `mascots/` (profile pictures), `components/`
  (Overlay, Avatar), `fonts/`, `brand/`.

## Shared changes outside this folder

Kept small and additive so Meadow looks and behaves the same:

- `components/Button`: `outline` and `light` variants and a `hero` size.
- Interviews › Prepare: optional `preset` to open with a practice session
  filled in (`pages/interviews/prepare/preset.ts`).
- Settings › System: the Interface switch (`presentation/ThemeSwitch.tsx`).
- Back end (ADRs 005 to 007 in `specs/decisions`): optional saved-search
  preferences (several locations, work setups and levels, contract types,
  minimum salary) as migration v25, and an optional profile avatar as v26.
  Query planning uses the new preferences when present.
- Main process: Copy buttons may write to the clipboard; the intro music may
  autoplay; the window fades in on launch.

## Previewing without Electron

`npm run preview:design` serves the real renderer against an in-process back
end at http://127.0.0.1:5199/scripts/design-preview/ (add `?theme=kompas`).
