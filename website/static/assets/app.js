/**
 * website/static/assets/app.js — progressive enhancement for the Omoya site:
 * a client-side search over the static index, and a light/dark/system theme
 * control persisted in localStorage. Vanilla ESM, no dependencies, no
 * network calls beyond the one same-origin fetch of the search index.
 */

/* ------------------------------------------------------------ theme */

const THEME_KEY = "omoya-theme";
const themeButtons = [...document.querySelectorAll("[data-theme-choice]")];

function applyTheme(choice) {
  const dark = choice === "dark"
    || (choice !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themeChoice = choice;
  for (const button of themeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === choice));
  }
}

let themeChoice = "site";
try { themeChoice = localStorage.getItem(THEME_KEY) || "site"; } catch { /* private mode */ }
applyTheme(themeChoice);
for (const button of themeButtons) {
  button.addEventListener("click", () => {
    themeChoice = button.dataset.themeChoice;
    try { localStorage.setItem(THEME_KEY, themeChoice); } catch { /* ignore */ }
    applyTheme(themeChoice);
  });
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (themeChoice === "site") applyTheme("site");
});

/* ------------------------------------------------------------ search */

const input = document.getElementById("search-input");
const results = document.getElementById("search-results");
// The site root, derived from this script's own URL — depth-proof without
// any hardcoded parent traversal.
const SITE_ROOT = import.meta.url.slice(0, import.meta.url.lastIndexOf("assets/app.js"));
let indexPromise = null;
let activeIndex = -1;

/** Load the index once. */
function loadIndex() {
  indexPromise ??= fetch(new URL("assets/search/index.json", SITE_ROOT))
    .then((r) => (r.ok ? r.json() : { entries: [] }))
    .catch(() => ({ entries: [] }));
  return indexPromise;
}

/** Score one entry: title-prefix > title > text; all query words must hit. */
function score(entry, words) {
  let total = 0;
  const title = entry.t.toLowerCase();
  const text = entry.x.toLowerCase();
  for (const word of words) {
    if (title.startsWith(word)) total += 6;
    else if (title.includes(word)) total += 4;
    else if (text.includes(word)) total += 1;
    else return 0;
  }
  return total;
}

function hideResults() {
  results.hidden = true;
  activeIndex = -1;
  input.removeAttribute("aria-activedescendant");
  input.setAttribute("aria-expanded", "false");
}

function showResults(matches) {
  results.innerHTML = "";
  if (matches.length === 0) {
    const empty = document.createElement("p");
    empty.className = "search-empty";
    empty.textContent = "No matches.";
    results.append(empty);
  }
  for (const [i, match] of matches.entries()) {
    const link = document.createElement("a");
    link.id = `search-result-${i}`;
    link.setAttribute("role", "option");
    link.href = new URL(match.u.slice(1), SITE_ROOT).pathname + (match.u.includes("#") ? match.u.slice(match.u.indexOf("#")) : "");
    const title = document.createElement("span");
    title.className = "result-title";
    title.textContent = match.t;
    const section = document.createElement("span");
    section.className = "result-section";
    section.textContent = match.s || match.p;
    link.append(title, section);
    results.append(link);
  }
  results.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

/* ------------------------------------------------ hash navigation */

/**
 * Scroll a hash target into view after the page has laid out. Search clicks
 * navigate to a NEW page whose browser-native anchor scroll fires before
 * styles settle and is never re-applied, so the landing position misses the
 * target; re-scrolling after two layout frames lands on it. Same-page hash
 * changes (no reload) are covered by the hashchange listener below. The
 * target receives transient focusability so keyboard/screen-reader users
 * land on it; a pre-existing tabindex is preserved.
 */
function scrollToHash(behavior = "smooth") {
  const hash = location.hash;
  if (!hash || hash.length < 2) return;
  const id = decodeURIComponent(hash.slice(1));
  const target = document.getElementById(id) || document.getElementsByName(id)[0];
  if (!target) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    target.scrollIntoView({ behavior, block: "start" });
    if (!target.hasAttribute("tabindex")) {
      target.setAttribute("tabindex", "-1");
      target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
    }
    target.focus({ preventScroll: true });
  }));
}

// A search result on ANOTHER page lands here after navigation; one on the
// SAME page only changes the hash (no reload), so listen for that too.
addEventListener("hashchange", () => scrollToHash());
scrollToHash("auto"); // initial load with a hash (search follow / deep link)

input.setAttribute("role", "combobox");
input.setAttribute("aria-controls", "search-results");
input.setAttribute("aria-expanded", "false");
input.setAttribute("aria-autocomplete", "list");

input.addEventListener("input", async () => {
  const words = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) { hideResults(); return; }
  const { entries } = await loadIndex();
  const current = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean).join(" ");
  if (current !== words.join(" ")) return; // a newer keystroke owns the results
  const matches = entries
    .map((entry) => [score(entry, words), entry])
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 8)
    .map(([, entry]) => entry);
  showResults(matches);
});

input.addEventListener("keydown", (event) => {
  const links = [...results.querySelectorAll("a")];
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (links.length === 0) return;
    event.preventDefault();
    activeIndex = event.key === "ArrowDown"
      ? (activeIndex + 1) % links.length
      : (activeIndex - 1 + links.length) % links.length;
    links.forEach((link, i) => link.classList.toggle("active", i === activeIndex));
    input.setAttribute("aria-activedescendant", links[activeIndex].id);
  } else if (event.key === "Enter" && activeIndex >= 0 && links[activeIndex]) {
    event.preventDefault();
    links[activeIndex].click();
  } else if (event.key === "Escape") {
    hideResults();
  }
});

document.addEventListener("click", (event) => {
  if (!results.hidden && !event.target.closest(".site-search")) hideResults();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== input
      && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "")) {
    event.preventDefault();
    input.focus();
  }
});
