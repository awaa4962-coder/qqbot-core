import { $ } from "./dom.js";
import { UI_PREFS_KEY } from "./metadata.js";

export function readUiPreferences() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(UI_PREFS_KEY) || "{}");
    return {
      theme: ["auto", "light", "dark"].includes(parsed.theme) ? parsed.theme : "auto",
      density: ["comfortable", "compact"].includes(parsed.density) ? parsed.density : "comfortable",
      blur: Math.min(52, Math.max(12, Number(parsed.blur || 28))),
    };
  } catch {
    return { theme: "auto", density: "comfortable", blur: 28 };
  }
}

export function applyUiPreferences(next = readUiPreferences()) {
  document.documentElement.dataset.theme = next.theme;
  document.documentElement.dataset.density = next.density;
  document.documentElement.style.setProperty("--backdrop-blur", `${next.blur}px`);
  if ($("blurStrength")) $("blurStrength").value = String(next.blur);
  document.querySelectorAll("[data-ui-theme]").forEach((button) => button.classList.toggle("active", button.dataset.uiTheme === next.theme));
  document.querySelectorAll("[data-ui-density]").forEach((button) => button.classList.toggle("active", button.dataset.uiDensity === next.density));
}

export function saveUiPreferences(changes) {
  const next = { ...readUiPreferences(), ...changes };
  window.localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next));
  applyUiPreferences(next);
}

export function applyBackground(state) {
  const root = document.documentElement;
  const mode = state && state.mode ? state.mode : "built-in";
  const uri = state && state.uri ? state.uri : "";
  root.dataset.backgroundMode = mode;
  root.style.setProperty("--custom-bg", uri ? `url("${uri.replaceAll('"', "%22")}")` : "none");
  document.querySelectorAll(".background-actions button").forEach((button) => {
    button.classList.remove("active");
    button.setAttribute("aria-pressed", "false");
  });
  const activeAction = mode === "desktop"
    ? "setDesktopBackground"
    : mode === "image"
      ? "chooseBackgroundImage"
      : "setBuiltInBackground";
  const active = document.querySelector(`button[data-action="${activeAction}"]`);
  if (active) {
    active.classList.add("active");
    active.setAttribute("aria-pressed", "true");
  }
}
