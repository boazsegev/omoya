---
name: web-build
description: "This skill should be used when building static sites."
---

# Static Site Builds

## Layers
- Keep data, content, templates and engine separate; each fact lives in one place.
- Keep the engine generic: no site facts, no per-section code.
- Declare every output, including 404, `robots.txt` and `sitemap.xml`, as a template in data.
- Keep prose in Markdown files referenced from data; keep labels inline.
- Use explicit slugs, never derived from titles.

## Templates
- Keep templates logic-less; shape data so they render trivially.
- Add generic derivations (position flags, `has_<list>`, dates) instead of per-collection code.
- Let Mustache context climbing reach parent values; copy only when names shadow.
- Escape by output type; emit raw HTML only from trusted sources.

## Builds
- Build from sources in one pass; never edit output.
- Render everything before replacing the previous output.
- Fail loudly on missing or unknown inputs.
- Add asset processing only when measured need justifies it.

## Resource
[`build.js`](build.js) implements these rules. Copy it into the project and change the config, not the code. Run `bun build.js --help` for the schema. It requires `marked` and `mustache` and replaces the output directory.
