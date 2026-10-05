---
name: visual-check
description: "This skill should be used when visually checking a web UI against intended layout or appearance using an already configured browser or screenshot tool; not for exact data assertions or installing browser automation."
---

# Visual Check a Web UI

1. Start the application and wait for its local URL to respond. For Omoya itself use `bun bin/scripts/web-demo --port 9911` (hermetic scripted model), or `om --serve --port 9911` for a configured app. Keep the server running through the check.
2. Capture the intended state at a specified viewport using the first available option:
   - Configured browser MCP (e.g. Playwright MCP): navigate to the URL, resize, then call its screenshot tool. If it returns an image, inspect that result; if it saves a PNG, `read` the saved path with `binary: true`.
   - Already installed Chrome/Chromium/Edge CLI: `chrome --headless --screenshot --window-size=1280,800 http://127.0.0.1:9911/` (substitute the installed Chromium-family executable; `screenshot.png` is written in the working folder, then move it to `ai-tmp/check.png` before reading). For Firefox, use `firefox --headless --screenshot ai-tmp/check.png http://127.0.0.1:9911/` if its local `--help` confirms the option.
   - macOS with a visible window: `screencapture -iw ai-tmp/check.png` to select that window interactively (screen recording permission may be required).
3. Call `read` with `{ path: "ai-tmp/check.png", binary: true }` (or the actual PNG path) so the model sees the image; compare against the requested intent at desktop and narrow viewports where relevant. Describe observed mismatches, change the UI, recapture and reread until it matches. Use DOM/text assertions for exact content, labels, behavior and accessibility; screenshots for layout, clipping, color and visual hierarchy. Report the viewport, method, result and any unverified aspects.

Use only the user's existing tools; if none can capture a readable screenshot, state the limitation instead of claiming a visual check. Keep screenshots inside the project tree and avoid capturing secrets.
