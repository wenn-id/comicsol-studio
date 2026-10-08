import { h, icon, replace } from "./dom.js";

// Only the theme choice is remembered. Project content never touches storage.
const STORAGE_KEY = "comicsol-studio:theme";

function readPreference() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function writePreference(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage can be unavailable in private windows; the toggle still works.
  }
}

export function initTheme(button) {
  let theme = readPreference() || "dark";

  function apply() {
    document.documentElement.dataset.theme = theme;
    const next = theme === "dark" ? "day" : "night";
    replace(
      button,
      icon(next),
      h("span", { class: "tool-label", text: next === "day" ? "Day shift" : "Night shift" }),
    );
    button.setAttribute("aria-label", `Switch to ${next} shift (${next === "day" ? "light" : "dark"} theme)`);
  }

  function toggle() {
    theme = theme === "dark" ? "light" : "dark";
    writePreference(theme);
    apply();
  }

  button.addEventListener("click", toggle);
  apply();
  return Object.freeze({ toggle, current: () => theme });
}
