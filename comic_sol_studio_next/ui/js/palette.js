import { h, uid } from "./dom.js";
import { openDialog } from "./dialogs.js";

export function matchesQuery(command, query) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = `${command.label} ${command.keywords || ""}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

// Command palette: one keyboard-first entry point to every Studio action that
// exists right now. Disabled commands stay listed with the reason they are off.
export function openCommandPalette({ commands, trigger = null }) {
  const listId = uid("palette-list");
  let active = 0;
  let visible = [];

  openDialog({
    title: "Commands",
    className: "sheet-palette",
    trigger,
    build: ({ close }) => {
      const input = h("input", {
        type: "text",
        class: "palette-input",
        role: "combobox",
        "aria-expanded": "true",
        "aria-controls": listId,
        "aria-autocomplete": "list",
        "aria-label": "Search commands",
        placeholder: "Type a command",
        autocomplete: "off",
        spellcheck: "false",
      });
      const list = h("ul", { id: listId, class: "palette-list", role: "listbox", "aria-label": "Commands" });

      function run(command) {
        if (!command || !command.enabled) return;
        close();
        command.run();
      }

      function render() {
        visible = commands().filter((command) => matchesQuery(command, input.value));
        if (active >= visible.length) active = Math.max(0, visible.length - 1);
        list.replaceChildren(...visible.map((command, index) => {
          const id = `${listId}-${index}`;
          const item = h(
            "li",
            {
              id,
              role: "option",
              class: "palette-item",
              "aria-selected": String(index === active),
              "aria-disabled": String(!command.enabled),
            },
            h("span", { class: "palette-label", text: command.label }),
            command.enabled
              ? (command.shortcut ? h("kbd", { text: command.shortcut }) : null)
              : h("span", { class: "palette-reason", text: command.reason || "Not available yet" }),
          );
          item.addEventListener("mousemove", () => {
            if (active !== index) {
              active = index;
              render();
            }
          });
          item.addEventListener("click", () => run(command));
          return item;
        }));
        if (!visible.length) {
          list.append(h("li", { class: "palette-empty", role: "presentation", text: "No command matches." }));
          input.removeAttribute("aria-activedescendant");
        } else {
          input.setAttribute("aria-activedescendant", `${listId}-${active}`);
          list.children[active]?.scrollIntoView({ block: "nearest" });
        }
      }

      input.addEventListener("input", () => {
        active = 0;
        render();
      });
      input.addEventListener("keydown", (event) => {
        if (!visible.length) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          active = (active + step + visible.length) % visible.length;
          render();
        } else if (event.key === "Enter") {
          event.preventDefault();
          run(visible[active]);
        }
      });
      render();
      queueMicrotask(() => input.focus());
      return h("div", { class: "palette" }, input, list);
    },
  });
}

export function openShortcutSheet({ trigger = null } = {}) {
  const rows = [
    ["Ctrl K", "Open commands"],
    ["Alt 1 to Alt 4", "Jump to Start, Plan, Generate, Review"],
    ["Ctrl Enter", "Submit the form you are typing in"],
    ["Esc", "Close a dialog or leave focus mode"],
    ["?", "Show this sheet"],
  ];
  openDialog({
    title: "Keyboard shortcuts",
    className: "sheet-shortcuts",
    trigger,
    build: () => h(
      "dl",
      { class: "shortcut-list" },
      rows.map(([keys, action]) => [h("dt", {}, h("kbd", { text: keys })), h("dd", { text: action })]),
    ),
  });
}
