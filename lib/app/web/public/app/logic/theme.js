/** Named-theme catalog excludes the OS sentinel and sorts visible choices. */
export function themeChoices(themes) {
  return [...new Set(["dark", "light", ...(themes ?? [])])].filter((item) => item !== "system").sort((a, b) => a.localeCompare(b));
}

/** Resolve system, built-in and named (single/dual) theme appearance. */
export function themeAppearance(name, prefs, isOsDark, choice = "system") {
  const named = !!name && !["system", "light", "dark"].includes(name) && prefs.themes?.includes(name);
  const osMode = isOsDark ? "dark" : "light";
  const dual = named && prefs.dualThemes?.includes(name);
  const mode = named ? dual ? (choice === "system" ? osMode : choice) : (prefs.themeModes?.[name] ?? osMode) : name === "system" || !name ? osMode : name;
  return { theme: named ? name : "", mode };
}
