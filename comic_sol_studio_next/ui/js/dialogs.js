import { h, icon, uid } from "./dom.js";

function restoreFocus(trigger) {
  if (trigger?.isConnected) trigger.focus();
  else document.getElementById("stage")?.focus({ preventScroll: true });
}

// A modal dialog that removes itself on close and returns focus to whatever
// opened it. Escape closes it through the native dialog cancel behaviour.
export function openDialog({ title, className = "", trigger = null, build }) {
  const headingId = uid("dialog-heading");
  const dialog = h("dialog", { class: `sheet ${className}`.trim(), "aria-labelledby": headingId });
  const close = () => dialog.close();
  const header = h(
    "header",
    { class: "sheet-head" },
    h("h2", { id: headingId, text: title }),
    h(
      "button",
      { type: "button", class: "icon-button", "aria-label": "Close", on: { click: close } },
      icon("close"),
    ),
  );
  dialog.append(header, build({ close, dialog }));
  dialog.addEventListener("close", () => {
    dialog.remove();
    restoreFocus(trigger);
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

// Explicit confirmation for every irreversible or cost-bearing action. The
// confirm button stays disabled while the action runs and re-enables on failure.
export function confirmDialog({
  title,
  body,
  confirmText,
  cancelText = "Cancel",
  trigger = null,
  onConfirm,
  onCancel = null,
}) {
  let confirm;
  const dialog = openDialog({
    title,
    className: "sheet-confirm",
    trigger,
    build: ({ close }) => {
      confirm = h("button", { type: "button", class: "button button-primary", text: confirmText });
      const cancel = h("button", { type: "button", class: "button", text: cancelText });
      const run = async (action) => {
        confirm.disabled = true;
        cancel.disabled = true;
        try {
          await action(close);
        } finally {
          if (confirm.isConnected) {
            confirm.disabled = false;
            cancel.disabled = false;
          }
        }
      };
      confirm.addEventListener("click", () => run(onConfirm));
      // A cancel with its own decision (such as rejecting a proposal) runs it;
      // otherwise cancel only closes and nothing changes.
      cancel.addEventListener("click", () => (onCancel ? run(onCancel) : close()));
      const paragraphs = (Array.isArray(body) ? body : [body]).map((item) => (
        typeof item === "string" ? h("p", { text: item }) : item
      ));
      return h(
        "div",
        { class: "sheet-body" },
        paragraphs,
        h("div", { class: "actions" }, confirm, cancel),
      );
    },
  });
  confirm.focus();
  return dialog;
}
