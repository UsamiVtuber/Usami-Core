# Design QA — modos de conversa da Usami

- Source visual truth:
  - `C:\Users\amari\AppData\Local\Temp\codex-clipboard-f635bdad-f322-4290-95e4-44ab3c893ede.png` (modo voz, 1920 × 912)
  - `C:\Users\amari\AppData\Local\Temp\codex-clipboard-ae6af649-0900-4622-baab-71ba16206f6e.png` (modo texto, 1914 × 912)
- Implementation screenshot: `browser-capture://iab/tab-1/usami-text-1600x900` and `browser-capture://iab/tab-1/usami-voice-1600x900`
- Viewport: 1600 × 900 CSS px, device scale factor 1. Responsive check: 390 × 844 CSS px.
- Density normalization: source and implementation were compared by viewport composition rather than raw pixel equality because the supplied references have slightly different desktop widths.
- States: text mode with empty history; voice mode with active-call controls; technical panel open; history hidden and reopened.

## Full-view comparison evidence

The implementation keeps the same hierarchy as the references: full-bleed nocturnal room, centered avatar, compact top status, discreet corner metadata, centered bottom composer, circular call controls in voice mode, and a low-left conversation surface in text mode. The Shiro model and the project's existing background are real runtime assets rather than screenshot substitutes.

## Focused-region evidence

The composer, call dock, history header, empty state, status pill, credit, and intimacy pill were readable in the full 1600 × 900 capture, so an additional crop was not necessary. Accessibility inspection separately confirmed that the input, call action, history toggle, settings panel, and close controls remained present and operable.

## Required fidelity surfaces

- Fonts and typography: DM Sans remains the compact interface face; Playfair Display is used only for the intimate empty-state line. Weights and sizes preserve the quiet hierarchy of the references.
- Spacing and layout rhythm: the 640 px composer, centered avatar, bottom control stack, and 360 px history panel reproduce the main proportions without covering the character's face.
- Colors and visual tokens: translucent near-black surfaces, restrained purple selection, green call action, red hang-up action, and low-contrast white metadata match the source direction.
- Image quality and asset fidelity: `background.png` remains full-bleed with a light blur and darkening treatment; `shiro.vrm` is rendered live at native WebGL quality.
- Copy and content: interface text is localized to Portuguese and describes the real Usami states rather than copying the reference product's brand or character copy.

## Comparison history

1. First pass at 778 × 648: the model and core controls were visible, but the credit competed with the intimacy pill at the tablet breakpoint.
   - Fix: stacked the corner metadata below 900 px and reduced only its compact text size.
   - Post-fix evidence: both the intimacy pill and complete Shiro credit were visible at 778 × 648.
2. First wide pass at 1600 × 900: composition matched, but the background was sharper and brighter than the references.
   - Fix: added a 2 px background blur, slight overscan, and reduced brightness.
   - Post-fix evidence: the avatar reads as the focal plane while the room retains recognizable depth and color.
3. Final desktop pass at 1600 × 900: no actionable P0, P1, or P2 visual mismatch remained.

## Primary interactions tested

- Hide and reopen text history.
- Enter voice mode and render its dedicated composer and call dock.
- End voice mode and return to the text layout.
- Open and close the technical avatar panel.
- Confirm Shiro's model report and curated expression controls remain available.
- Browser console checked: no runtime errors; only the existing Three.js `Clock` deprecation warning.

## Findings

- No actionable P0, P1, or P2 findings remain.

## Follow-up polish

- P3: the exact availability and persistence of browser speech recognition still varies by browser; Chrome/Edge remain the intended voice-mode runtime.

final result: passed
