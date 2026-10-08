import { h, icon } from "./dom.js";

const AUTO_DISMISS_MS = 6000;
const MAX_TOASTS = 3;
const TONES = new Set(["info", "success", "error"]);

// Status messages stack in one polite live region. Routine messages leave on
// their own; errors stay until the creator dismisses them.
export function createToaster(region) {
  function dismiss(toast) {
    if (!toast.isConnected || toast.dataset.leaving) return;
    toast.dataset.leaving = "true";
    setTimeout(() => toast.remove(), 180);
  }

  return function announce(message, tone = "info") {
    if (!message) return;
    const kind = TONES.has(tone) ? tone : "info";
    const close = h(
      "button",
      { type: "button", class: "toast-close", "aria-label": "Dismiss message" },
      icon("close"),
    );
    const toast = h(
      "div",
      { class: `toast toast-${kind}` },
      h("span", { class: "toast-mark", "aria-hidden": "true" }),
      h("p", { class: "toast-text", text: message }),
      close,
    );
    close.addEventListener("click", () => dismiss(toast));
    region.append(toast);
    while (region.childElementCount > MAX_TOASTS) region.firstElementChild.remove();
    if (kind === "error") return;

    let timer = setTimeout(() => dismiss(toast), AUTO_DISMISS_MS);
    const hold = () => clearTimeout(timer);
    const release = () => {
      clearTimeout(timer);
      timer = setTimeout(() => dismiss(toast), AUTO_DISMISS_MS / 2);
    };
    toast.addEventListener("mouseenter", hold);
    toast.addEventListener("focusin", hold);
    toast.addEventListener("mouseleave", release);
    toast.addEventListener("focusout", release);
  };
}
