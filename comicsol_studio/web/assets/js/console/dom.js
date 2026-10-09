// A small element builder. Text is always set with textContent, never parsed as HTML.

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set(["svg", "path", "rect", "circle", "line", "polyline", "g", "text"]);

export function h(tag, props = {}, ...children) {
  const svg = SVG_TAGS.has(tag);
  const element = svg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.setAttribute("class", value);
    else if (key === "dataset") Object.assign(element.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(element.style, value);
    else if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "value" && !svg) element.value = value;
    else if (key === "checked" && !svg) element.checked = Boolean(value);
    else if (value === true) element.setAttribute(key, "");
    else element.setAttribute(key, String(value));
  }
  append(element, children);
  return element;
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(parent, ...children) {
  parent.replaceChildren();
  append(parent, children);
  return parent;
}

// Square-capped line icons drawn for Studio's own actions.
const ICONS = {
  library: "M4 5h6v14H4zM14 5h6v14h-6z",
  plan: "M5 4h14v16H5zM9 9h6M9 13h6M9 17h3",
  render: "M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4",
  review: "M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  finish: "M6 3h9l3 3v15H6zM9 12l2 2 4-4",
  overview: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  plus: "M12 5v14M5 12h14",
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
  download: "M12 4v12M7 11l5 5 5-5M4 20h16",
  close: "M6 6l12 12M18 6L6 18",
  check: "M5 12.5l4.5 4.5L19 7",
  warn: "M12 4l9 16H3zM12 10v4M12 17v.5",
  activity: "M3 12h4l3-7 4 14 3-7h4",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
  sun: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 2v2M12 20v2M2 12h2M20 12h2",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l4 4",
  arrowLeft: "M19 12H5M11 6l-6 6 6 6",
  book: "M4 5c3-1 5-1 8 1 3-2 5-2 8-1v14c-3-1-5-1-8 1-3-2-5-2-8-1zM12 6v14",
};

export function icon(name, size = 18) {
  return h(
    "svg",
    { class: "icon", width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" },
    h("path", {
      d: ICONS[name] || ICONS.plus,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.6",
      "stroke-linecap": "square",
      "stroke-linejoin": "miter",
    }),
  );
}

export function debounce(fn, wait) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}
