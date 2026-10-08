// DOM construction helpers. Every string reaches the page through textContent
// or setAttribute, never through HTML parsing.

const PROPERTIES = new Set(["value", "checked", "disabled", "hidden", "selected", "indeterminate"]);
const SVG_NS = "http://www.w3.org/2000/svg";

function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else if (child instanceof Node) node.append(child);
    else node.append(document.createTextNode(String(child)));
  }
}

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.setAttribute("class", value);
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style") {
      for (const [property, setting] of Object.entries(value)) node.style.setProperty(property, setting);
    } else if (key === "on") {
      for (const [type, handler] of Object.entries(value)) node.addEventListener(type, handler);
    } else if (PROPERTIES.has(key)) node[key] = value;
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
}

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  applyProps(node, props);
  appendChildren(node, children);
  return node;
}

export function svg(tag, props = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  applyProps(node, props);
  appendChildren(node, children);
  return node;
}

export function replace(node, ...children) {
  node.replaceChildren();
  appendChildren(node, children);
  return node;
}

let uniqueCounter = 0;
export function uid(prefix) {
  uniqueCounter += 1;
  return `${prefix}-${uniqueCounter}`;
}

// Ink-style icons drawn for this Studio: square caps and 2px strokes, so they
// read as production marks rather than a generic icon library.
const ICONS = {
  command: ["M4 6h16", "M4 12h10", "M4 18h13"],
  log: ["M5 4v16", "M9 6h10", "M9 12h10", "M9 18h7"],
  night: ["M15 3a8 8 0 1 0 6 13A9 9 0 0 1 15 3Z"],
  day: ["M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10Z", "M12 1v3", "M12 20v3", "M1 12h3", "M20 12h3", "M4.2 4.2l2.1 2.1", "M17.7 17.7l2.1 2.1", "M4.2 19.8l2.1-2.1", "M17.7 6.3l2.1-2.1"],
  focus: ["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5"],
  refresh: ["M20 6v5h-5", "M19 11a7 7 0 1 0-2 6"],
  upload: ["M12 16V4", "M7 9l5-5l5 5", "M4 20h16"],
  download: ["M12 4v12", "M7 11l5 5l5-5", "M4 20h16"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  pause: ["M8 5v14", "M16 5v14"],
  play: ["M7 4l12 8l-12 8Z"],
  check: ["M4 12l5 5L20 6"],
  alert: ["M12 3l10 18H2Z", "M12 10v5", "M12 18v.5"],
  expand: ["M14 4h6v6", "M10 20H4v-6", "M20 4l-7 7", "M4 20l7-7"],
};

export function icon(name, label = "") {
  const paths = ICONS[name] || [];
  return svg(
    "svg",
    {
      class: "icon",
      viewBox: "0 0 24 24",
      "aria-hidden": label ? null : "true",
      role: label ? "img" : null,
      "aria-label": label || null,
      focusable: "false",
    },
    paths.map((d) => svg("path", { d })),
  );
}
