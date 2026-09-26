/**
 * website/static/assets/app.js — progressive enhancement for the Omoya site:
 * a client-side search over the static index, a light/dark/system theme
 * control persisted in localStorage, API sidebar scroll-spy, install tabs
 * with copy buttons, and scroll reveals. Vanilla ESM, no dependencies, no
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

/* ------------------------------------------------------------ header */

/**
 * Publish the sticky header's bottom edge as --header-h so hash targets,
 * the sticky API sidebar, and scroll-spy all sit below it. The header wraps
 * to more rows on narrow screens, so it is measured rather than assumed.
 */
const header = document.querySelector(".site-header");
function headerBottom() {
  if (!header) return 0;
  return Math.ceil(header.offsetHeight + (parseFloat(getComputedStyle(header).top) || 0));
}
function publishHeaderHeight() {
  if (header) document.documentElement.style.setProperty("--header-h", `${headerBottom()}px`);
}
publishHeaderHeight();
if (header && "ResizeObserver" in window) new ResizeObserver(publishHeaderHeight).observe(header);

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

/* ------------------------------------------------ sidebar scroll-spy */

/**
 * Highlight the sidebar sub-navigation entry for the symbol currently in
 * view. Each `.api-sections` hash link is paired with its section; an
 * IntersectionObserver tracks visibility and the top-most visible entry
 * wins (sections are in document order). Pure enhancement: without JS the
 * sub-navigation is simply a static list of working hash links.
 */
const spyLinks = [...document.querySelectorAll('.api-sections a[href^="#"]')];
if (spyLinks.length && "IntersectionObserver" in window) {
  const pairs = spyLinks
    .map((link) => [link, document.getElementById(decodeURIComponent(link.hash.slice(1)))])
    .filter(([, section]) => section);
  const visible = new Set();
  const highlight = () => {
    let current = null;
    for (const [link, section] of pairs) {
      link.classList.remove("current");
      if (!current && visible.has(section)) current = link;
    }
    // Nothing in view (between sections): keep the last entry above the fold.
    if (!current) {
      for (const [link, section] of pairs) {
        if (section.getBoundingClientRect().top < innerHeight * 0.4) current = link;
      }
    }
    current?.classList.add("current");
    // Keep the highlight visible inside the sidebar's own scroll area only
    // (scrollIntoView would also move the page).
    const nav = current?.closest(".api-nav");
    if (nav && nav.scrollHeight > nav.clientHeight) {
      const top = current.getBoundingClientRect().top - nav.getBoundingClientRect().top;
      if (top < 0 || top > nav.clientHeight - current.offsetHeight) {
        nav.scrollTop += top - nav.clientHeight / 3;
      }
    }
  };
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    }
    highlight();
  }, { rootMargin: `-${headerBottom()}px 0px -70% 0px` }); // ignore what the sticky header covers
  for (const [, section] of pairs) observer.observe(section);
  highlight();
}

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

/* ------------------------------------------------ install tabs + copy */

/**
 * Install boxes: tab buttons switch panels (arrow keys move between tabs);
 * Copy writes the panel's plain command text. The markup stacks every panel
 * and hides the controls until html.js is set, so nothing depends on this.
 */
for (const box of document.querySelectorAll("[data-tabs]")) {
  const tabs = [...box.querySelectorAll("[data-tab]")];
  const panels = [...box.querySelectorAll("[data-panel]")];
  box.querySelector(".install-tabs")?.setAttribute("role", "tablist");
  const select = (tab, focus = false) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    }
    for (const p of panels) p.toggleAttribute("data-inactive", p.dataset.panel !== tab.dataset.tab);
    if (focus) tab.focus();
  };
  for (const [i, tab] of tabs.entries()) {
    tab.setAttribute("role", "tab");
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (step) select(tabs[(i + step + tabs.length) % tabs.length], true);
    });
  }
  for (const p of panels) p.setAttribute("role", "tabpanel");
  select(tabs.find((t) => t.getAttribute("aria-selected") === "true") ?? tabs[0]);
}

for (const button of document.querySelectorAll("button.copy[data-copy]")) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select ↑";
    }
    button.classList.add("copied");
    setTimeout(() => { button.textContent = "Copy"; button.classList.remove("copied"); }, 1600);
  });
}

/* ------------------------------------------------ scroll reveal */

/**
 * `.reveal` elements rise in once, the first time they enter the viewport.
 * Without IntersectionObserver, or with reduced motion requested, they are
 * shown immediately.
 */
const reveals = [...document.querySelectorAll(".reveal")];
if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) {
  for (const el of reveals) el.classList.add("in");
} else {
  const revealer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("in");
      revealer.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -8% 0px" });
  for (const el of reveals) revealer.observe(el);
}
