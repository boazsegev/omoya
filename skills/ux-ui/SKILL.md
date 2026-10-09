---
name: ux-ui
description: "Use when designing, specifying, or reviewing user interfaces and user experience for any product: layout, interaction, accessibility, and usability requirements; augments web-specific UX flow design or audits (web-ux) and HTML/CSS implementation (web-frontend)."
---

# UX/UI Requirements and Best Practices

## Method
- Define the primary user tasks first; measure success by completion rate, time, and errors.
- Validate with real users or analytics; label untested conclusions as heuristic.
- Review against Nielsen's 10 heuristics: visible system status, real-world language, user control and exits, consistency, error prevention, recognition over recall, efficiency shortcuts, minimalism, plain-language error recovery, searchable task-focused help.

## Non-negotiable requirements
- Accessibility MUST meet WCAG 2.2 AA: contrast >= 4.5:1 for normal text and >= 3:1 for large text and UI components; targets >= 24x24 CSS px (44 px comfortable); full keyboard operability; visible focus; never convey meaning by color alone.
- Every interactive element MUST define all states: default, hover/focus, active, disabled, loading, error, and empty.
- Feedback MUST arrive within 100 ms; show progress for waits over 1 s.
- Error messages MUST use plain language, appear beside the cause, and suggest a fix; never discard user input.
- Destructive actions MUST be recoverable; prefer undo over confirmation dialogs.

## Layout and hierarchy
- One primary action per view; order content by attention: value and primary action first, proof near the decision, reference last.
- Group related items by Gestalt principles (proximity, similarity, common region); build hierarchy with scale, weight, and spacing before color.
- Minimize choices per decision (Hick's Law); make frequent targets large and close (Fitts's Law).
- Follow platform and industry conventions (Jakob's Law); deviate only with measured justification.
- Disclose complexity progressively; prefill, default, and remember safely.

## Forms and content
- Ask only what the task needs; validate inline; name buttons by outcome ("Save changes", not "OK").
- Speak the user's language; front-load labels; no internal jargon or error codes.

## Performance and responsiveness
- Perceived speed is UX: target LCP < 2.5 s, use skeleton screens over spinners, and design responsive layouts across viewport sizes, touch-first on mobile.

## Reviews
- Report location, violated principle, affected task, severity, evidence, and specific fix, ordered by user impact.
