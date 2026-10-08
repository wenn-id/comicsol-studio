// Shared console components: fields, chip lists, segmented controls, dialogs, toasts,
// and the empty / loading / error states every data view uses.

import { h, icon, mount } from "./dom.js";

let fieldCounter = 0;
const nextId = (prefix) => `${prefix}-${++fieldCounter}`;

export function button(label, { kind = "quiet", iconName, onClick, type = "button", disabled, title, size } = {}) {
  return h(
    "button",
    { type, class: `btn btn--${kind}${size ? ` btn--${size}` : ""}`, onclick: onClick, disabled, title },
    iconName ? icon(iconName, 16) : null,
    label ? h("span", {}, label) : null,
  );
}

// Run an async action with the button disabled and labelled as working.
export async function busy(buttonElement, action, workingLabel = "Working") {
  const label = buttonElement.querySelector("span");
  const original = label?.textContent;
  buttonElement.disabled = true;
  buttonElement.setAttribute("aria-busy", "true");
  if (label) label.textContent = `${workingLabel}…`;
  try {
    return await action();
  } finally {
    buttonElement.disabled = false;
    buttonElement.removeAttribute("aria-busy");
    if (label) label.textContent = original;
  }
}

export function field(label, control, { hint, error, wide } = {}) {
  const id = control.id || nextId("field");
  control.id = id;
  const hintId = hint ? `${id}-hint` : null;
  const errorId = error ? `${id}-error` : null;
  const described = [hintId, errorId].filter(Boolean).join(" ");
  if (described) control.setAttribute("aria-describedby", described);
  if (error) control.setAttribute("aria-invalid", "true");
  return h(
    "div",
    { class: `field${wide ? " field--wide" : ""}${error ? " field--error" : ""}` },
    h("label", { class: "field__label", for: id }, label),
    control,
    hint ? h("p", { class: "field__hint", id: hintId }, hint) : null,
    error ? h("p", { class: "field__error", id: errorId }, error) : null,
  );
}

export function textInput(value, onInput, attrs = {}) {
  return h("input", { class: "input", type: "text", value: value ?? "", oninput: (event) => onInput(event.target.value), ...attrs });
}

export function textArea(value, onInput, attrs = {}) {
  const area = h("textarea", { class: "input input--area", rows: attrs.rows || 3, oninput: (event) => onInput(event.target.value), ...attrs });
  area.value = value ?? "";
  return area;
}

export function select(value, options, onChange, attrs = {}) {
  return h(
    "select",
    { class: "input input--select", onchange: (event) => onChange(event.target.value), ...attrs },
    options.map(([optionValue, label]) => h("option", { value: optionValue, selected: optionValue === value }, label)),
  );
}

// A list of short strings: type and press Enter (or comma) to add, remove with the x.
// The control keeps its own DOM in step, so editing never steals focus from the input.
export function chips(values, onChange, { placeholder = "Add and press Enter", label, max } = {}) {
  let list = Array.isArray(values) ? [...values] : [];
  const items = h("span", { class: "chips__items" });
  const input = h("input", {
    class: "chips__input",
    type: "text",
    "aria-label": label ? `Add to ${label}` : placeholder,
  });
  const commit = (next) => {
    list = next;
    draw();
    onChange([...list]);
  };
  const draw = () => {
    const full = Boolean(max && list.length >= max);
    input.disabled = full;
    input.placeholder = full ? `At most ${max}` : placeholder;
    mount(
      items,
      list.map((value, index) =>
        h(
          "span",
          { class: "chip" },
          h("span", {}, value),
          h(
            "button",
            {
              type: "button",
              class: "chip__remove",
              "aria-label": `Remove ${value}`,
              onclick: () => {
                commit(list.filter((_, i) => i !== index));
                input.focus();
              },
            },
            icon("close", 12),
          ),
        ),
      ),
    );
  };
  const add = () => {
    const value = input.value.trim().replace(/,$/, "").trim();
    input.value = "";
    if (value && !list.includes(value) && !(max && list.length >= max)) commit([...list, value]);
  };
  input.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === ",") && input.value.trim()) {
      event.preventDefault();
      add();
    } else if (event.key === "Backspace" && !input.value && list.length) {
      commit(list.slice(0, -1));
    }
  });
  input.addEventListener("blur", add);
  draw();
  return h("div", { class: "chips", onclick: (event) => event.target === event.currentTarget && input.focus() }, items, input);
}

export function segmented(value, options, onChange, { label } = {}) {
  return h(
    "div",
    { class: "segmented", role: "radiogroup", "aria-label": label },
    options.map(([optionValue, optionLabel, tone]) =>
      h(
        "button",
        {
          type: "button",
          role: "radio",
          class: `segmented__option${tone ? ` segmented__option--${tone}` : ""}`,
          "aria-checked": String(optionValue === value),
          onclick: () => onChange(optionValue),
          onkeydown: (event) => {
            const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
            if (!(event.key in keys)) return;
            event.preventDefault();
            const index = options.findIndex(([v]) => v === value);
            const next = options[(index + keys[event.key] + options.length) % options.length][0];
            onChange(next);
            requestAnimationFrame(() => event.target.parentElement?.querySelector('[aria-checked="true"]')?.focus());
          },
          tabindex: optionValue === value || (value == null && optionValue === options[0][0]) ? "0" : "-1",
        },
        optionLabel,
      ),
    ),
  );
}

export function badge(text, tone = "neutral") {
  return h("span", { class: `badge badge--${tone}` }, text);
}

export function loadingState(text = "Loading") {
  return h("div", { class: "state state--loading", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("p", {}, `${text}…`));
}

export function emptyState(title, text, action) {
  return h("div", { class: "state" }, h("p", { class: "state__title" }, title), text ? h("p", { class: "state__text" }, text) : null, action || null);
}

export function errorState(error, retry) {
  return h(
    "div",
    { class: "state state--error", role: "alert" },
    h("p", { class: "state__title" }, error?.message || "Something went wrong."),
    error?.hint ? h("p", { class: "state__text" }, error.hint) : null,
    error?.details?.length ? h("ul", { class: "state__details" }, error.details.slice(0, 8).map((detail) => h("li", {}, detail))) : null,
    retry ? button("Try again", { kind: "ghost", onClick: retry }) : null,
  );
}

// Toasts --------------------------------------------------------------------------

let toastRegion = null;
export function toast(message, { tone = "info", detail, timeout = 5200 } = {}) {
  if (!toastRegion) {
    toastRegion = h("div", { class: "toasts", role: "region", "aria-label": "Notifications", "aria-live": "polite" });
    document.body.append(toastRegion);
  }
  const item = h(
    "div",
    { class: `toast toast--${tone}` },
    h("div", {}, h("p", { class: "toast__message" }, message), detail ? h("p", { class: "toast__detail" }, detail) : null),
    h("button", { type: "button", class: "toast__close", "aria-label": "Dismiss", onclick: () => item.remove() }, icon("close", 14)),
  );
  toastRegion.append(item);
  if (timeout) setTimeout(() => item.remove(), tone === "error" ? timeout * 2 : timeout);
  return item;
}

export function toastError(error) {
  const detail = [error?.hint, ...(error?.details || []).slice(0, 3)].filter(Boolean).join(" ");
  toast(error?.message || "Something went wrong.", { tone: "error", detail });
}

// Dialogs -------------------------------------------------------------------------

export function dialog({ title, body, actions = [], wide = false, onClose }) {
  const titleId = nextId("dialog-title");
  const element = h(
    "dialog",
    { class: `dialog${wide ? " dialog--wide" : ""}`, "aria-labelledby": titleId },
    h(
      "div",
      { class: "dialog__head" },
      h("h2", { class: "dialog__title", id: titleId }, title),
      h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: () => close() }, icon("close")),
    ),
    h("div", { class: "dialog__body" }, body),
    actions.length ? h("div", { class: "dialog__actions" }, actions) : null,
  );
  const close = () => {
    element.close();
  };
  element.addEventListener("close", () => {
    element.remove();
    onClose?.();
  });
  element.addEventListener("click", (event) => {
    if (event.target === element) close();
  });
  document.body.append(element);
  element.showModal();
  return { element, close };
}

export function confirmDialog({ title, text, confirmLabel, tone = "amber", details }) {
  return new Promise((resolve) => {
    let answer = false;
    const confirm = button(confirmLabel, {
      kind: tone,
      onClick: () => {
        answer = true;
        handle.close();
      },
    });
    const handle = dialog({
      title,
      body: h("div", {}, h("p", { class: "dialog__text" }, text), details ? h("ul", { class: "dialog__list" }, details.map((item) => h("li", {}, item))) : null),
      actions: [button("Cancel", { kind: "ghost", onClick: () => handle.close() }), confirm],
      onClose: () => resolve(answer),
    });
    confirm.focus();
  });
}

export function fileDrop({ accept, label, onFile, hint }) {
  const input = h("input", { type: "file", accept, class: "visually-hidden", onchange: (event) => event.target.files[0] && onFile(event.target.files[0]) });
  const zone = h(
    "label",
    {
      class: "drop",
      ondragover: (event) => {
        event.preventDefault();
        zone.dataset.over = "true";
      },
      ondragleave: () => delete zone.dataset.over,
      ondrop: (event) => {
        event.preventDefault();
        delete zone.dataset.over;
        const file = event.dataTransfer.files[0];
        if (file) onFile(file);
      },
    },
    input,
    icon("upload", 20),
    h("span", { class: "drop__label" }, label),
    hint ? h("span", { class: "drop__hint" }, hint) : null,
  );
  return zone;
}
