// Library: every comic on this machine, and the composer that starts a new one from an
// idea, an engine starter, or a portable archive.

import { api, newIdempotencyKey } from "../api.js";
import { h, icon, mount } from "../dom.js";
import { formatBytes, relativeTime, statusLabel, utf8Length } from "../model.js";
import { busy, button, errorState, field, fileDrop, loadingState, segmented, textArea, textInput, toastError } from "../ui.js";

const library = { projects: null, starters: null, error: null, loading: false };
const composer = { tab: "idea", title: "", prompt: "", mode: "short_prompt", pages: 2, language: "en", key: newIdempotencyKey(), archive: null };

async function load(ctx, container) {
  library.loading = true;
  try {
    const [projects, starters] = await Promise.all([api.projects(), library.starters ? library.starters : api.starters()]);
    library.projects = projects;
    library.starters = starters;
    library.error = null;
  } catch (error) {
    library.error = error;
  } finally {
    library.loading = false;
  }
  if (ctx.route.name === "library") renderLibrary(container, ctx);
}

export function renderLibrary(container, ctx) {
  if (!library.projects && !library.loading && !library.error) load(ctx, container);
  const compose = ctx.compose || (library.projects && library.projects.length === 0);
  mount(
    container,
    h(
      "div",
      { class: "page page--library" },
      h(
        "header",
        { class: "page__head" },
        h("div", {}, h("p", { class: "page__eyebrow" }, "Library"), h("h1", { class: "page__title" }, "Your comics")),
        compose ? null : h("a", { href: "/studio/new", "data-link": true, class: "btn btn--amber" }, icon("plus", 16), h("span", {}, "New comic")),
      ),
      compose ? composerPanel(ctx, container) : null,
      library.error
        ? errorState(library.error, () => {
            library.error = null;
            load(ctx, container);
          })
        : !library.projects
          ? loadingState("Reading your projects")
          : library.projects.length
            ? h("section", { "aria-label": "Projects" }, h("ul", { class: "covers" }, library.projects.map((project) => cover(project))))
            : null,
    ),
  );
}

function cover(project) {
  const panels = project.panels || {};
  const total = project.panelCount || 0;
  return h(
    "li",
    { class: "cover" },
    h(
      "a",
      { href: `/studio/p/${project.id}`, "data-link": true, class: "cover__link" },
      h(
        "div",
        { class: "cover__art" },
        project.thumbnail
          ? h("img", { src: project.thumbnail, alt: "", loading: "lazy", decoding: "async" })
          : h("div", { class: "cover__blank" }, h("span", {}, project.status === "INIT" ? "No plan yet" : "No art yet")),
      ),
      h("p", { class: "cover__title" }, project.title),
      h(
        "p",
        { class: "cover__meta" },
        h("span", {}, statusLabel(project.status)),
        total ? h("span", {}, `${panels.accepted || 0}/${total} panels accepted`) : null,
        project.updatedAt ? h("span", {}, relativeTime(project.updatedAt)) : null,
      ),
    ),
  );
}

function composerPanel(ctx, container) {
  const rerender = () => renderLibrary(container, ctx);
  const tabs = [
    ["idea", "Write an idea"],
    ["starter", "Use a starter"],
    ["archive", "Import archive"],
  ];
  const tabList = h(
    "div",
    { class: "tabs", role: "tablist", "aria-label": "How to start" },
    tabs.map(([id, label]) =>
      h(
        "button",
        {
          type: "button",
          role: "tab",
          class: "tabs__tab",
          id: `start-${id}`,
          "aria-selected": String(composer.tab === id),
          "aria-controls": "start-panel",
          tabindex: composer.tab === id ? "0" : "-1",
          onclick: () => {
            composer.tab = id;
            rerender();
            container.querySelector(`#start-${id}`)?.focus();
          },
          onkeydown: (event) => {
            const index = tabs.findIndex(([tab]) => tab === composer.tab);
            const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
            if (!step) return;
            composer.tab = tabs[(index + step + tabs.length) % tabs.length][0];
            rerender();
            container.querySelector(`#start-${composer.tab}`)?.focus();
          },
        },
        label,
      ),
    ),
  );
  const body = { idea: ideaForm, starter: starterList, archive: archiveForm }[composer.tab](ctx, rerender);
  return h(
    "section",
    { class: "composer", "aria-labelledby": "composer-title" },
    h("div", { class: "composer__head" }, h("h2", { class: "composer__title", id: "composer-title" }, "Start a comic"), library.projects?.length ? h("a", { href: "/studio/", "data-link": true, class: "btn btn--ghost btn--small" }, "Close") : null),
    tabList,
    h("div", { class: "composer__body", role: "tabpanel", id: "start-panel", "aria-labelledby": `start-${composer.tab}` }, body),
  );
}

async function created(ctx, project) {
  composer.key = newIdempotencyKey();
  composer.title = "";
  composer.prompt = "";
  composer.archive = null;
  library.projects = null;
  ctx.navigate(`/studio/p/${project.id}${project.status === "INIT" ? "/plan" : ""}`);
}

function ideaForm(ctx, rerender) {
  const bytes = utf8Length(composer.prompt);
  const limit = ctx.session.limits.sourceBytes;
  const counter = h("span", { class: `meter${bytes > limit ? " meter--over" : ""}` }, `${formatBytes(bytes)} of ${formatBytes(limit)}`);
  const submit = button("Create comic", { kind: "amber", type: "submit" });
  const form = h(
    "form",
    {
      class: "form-grid",
      onsubmit: async (event) => {
        event.preventDefault();
        if (!composer.title.trim() || !composer.prompt.trim()) {
          form.querySelector(":invalid")?.focus();
          return;
        }
        try {
          const project = await busy(submit, () =>
            api.create(
              { title: composer.title.trim(), prompt: composer.prompt, mode: composer.mode, language: composer.language.trim() || "en", pageCount: composer.pages },
              composer.key,
            ),
          "Creating");
          created(ctx, project);
        } catch (error) {
          toastError(error);
        }
      },
      onkeydown: (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) form.requestSubmit();
      },
    },
    field("Title", textInput(composer.title, (value) => (composer.title = value), { required: true, maxlength: 120, autocomplete: "off", placeholder: "The comic's working title" })),
    field(
      composer.mode === "short_prompt" ? "Idea" : "Story",
      textArea(
        composer.prompt,
        (value) => {
          composer.prompt = value;
          const size = utf8Length(value);
          counter.textContent = `${formatBytes(size)} of ${formatBytes(limit)}`;
          counter.classList.toggle("meter--over", size > limit);
        },
        { required: true, rows: composer.mode === "short_prompt" ? 4 : 10, placeholder: composer.mode === "short_prompt" ? "Who, where, and what changes. One or two sentences is enough." : "Paste the story the comic should adapt." },
      ),
      { wide: true, hint: "Studio saves your original text alongside the plan." },
    ),
    h(
      "div",
      { class: "form-row" },
      field(
        "Source",
        segmented(composer.mode, [["short_prompt", "Short idea"], ["pasted_story", "Pasted story"]], (value) => {
          composer.mode = value;
          rerender();
        }, { label: "Source" }),
      ),
      field(
        "Pages",
        segmented(composer.pages, [[1, "1"], [2, "2"], [3, "3"], [4, "4"]], (value) => {
          composer.pages = value;
          rerender();
        }, { label: "Pages" }),
      ),
      field("Language", textInput(composer.language, (value) => (composer.language = value), { maxlength: 35, size: 6, autocomplete: "off" }), { hint: "A tag such as en or id" }),
    ),
    h("div", { class: "form-actions" }, counter, submit),
  );
  return form;
}

function starterList(ctx) {
  if (!library.starters) return loadingState("Reading the engine's starters");
  return h(
    "div",
    {},
    h("p", { class: "composer__note" }, "Start with a prepared story and cast. You can edit the plan before making the artwork."),
    h(
      "ul",
      { class: "starters" },
      library.starters.map((starter) => {
        const choose = button(`Start “${starter.title}”`, { kind: "ghost", size: "small" });
        choose.addEventListener("click", async () => {
          try {
            const project = await busy(choose, () => api.create({ starter: starter.id }, newIdempotencyKey()), "Creating");
            created(ctx, project);
          } catch (error) {
            toastError(error);
          }
        });
        return h(
          "li",
          { class: "starter" },
          h("p", { class: "starter__title" }, starter.title),
          h("p", { class: "starter__logline" }, starter.logline),
          h(
            "p",
            { class: "starter__meta" },
            `${starter.pages} ${starter.pages === 1 ? "page" : "pages"} · ${starter.panels} panels · ${starter.characters.join(", ")}`,
          ),
          choose,
        );
      }),
    ),
  );
}

function archiveForm(ctx, rerender) {
  const suffix = ctx.session.archiveSuffix;
  const submit = button("Validate and import", { kind: "amber", disabled: !composer.archive });
  submit.addEventListener("click", async () => {
    try {
      const project = await busy(submit, () => api.importArchive(composer.archive, composer.key), "Importing");
      created(ctx, project);
    } catch (error) {
      toastError(error);
    }
  });
  return h(
    "div",
    { class: "form-grid" },
    h("p", { class: "composer__note" }, `A ${suffix} archive exported from any Comic Sol install. The engine checks every file before the project appears here.`),
    fileDrop({
      accept: suffix,
      label: composer.archive ? composer.archive.name : `Choose or drop a ${suffix} file`,
      hint: composer.archive ? formatBytes(composer.archive.size) : null,
      onFile: (file) => {
        composer.archive = file;
        rerender();
      },
    }),
    h("div", { class: "form-actions" }, submit),
  );
}

export function resetLibrary() {
  library.projects = null;
}
