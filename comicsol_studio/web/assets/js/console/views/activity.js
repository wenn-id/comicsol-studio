// Activity drawer: what Studio did, and what the engine recorded in its own event log.

import { api } from "../api.js";
import { h, icon, mount } from "../dom.js";
import { providerName, relativeTime } from "../model.js";
import { errorState, loadingState } from "../ui.js";

const ENGINE_EVENTS = {
  "project.created": "Project created",
  "project.transitioned": "Lifecycle moved",
  "handoff.prepared": "Render jobs prepared",
  "handoff.result_accepted": "Image accepted",
  "handoff.failure_recorded": "Render failure recorded",
  "attempt.promoted": "Panel promoted",
  "stage.recorded": "Stage recorded",
};

export async function renderActivity(drawer, ctx, close) {
  const projectId = ctx.project.id;
  const closeButton = h("button", { type: "button", class: "icon-btn", "aria-label": "Close activity", onclick: close }, icon("close"));
  const body = h("div", { class: "drawer__body" }, loadingState("Reading activity"));
  mount(drawer, h("div", { class: "drawer__head" }, h("h2", { class: "section-title" }, "Activity"), closeButton), body);
  try {
    const activity = await api.activity(projectId);
    if (drawer.hidden || ctx.project.id !== projectId) return;
    const runs = ctx.project.runs || [];
    mount(
      body,
      runs.length
        ? h(
            "section",
            {},
            h("h3", { class: "card__sub" }, "Model runs"),
            h(
              "ol",
              { class: "log" },
              runs.slice(0, 12).map((run) =>
                h("li", { class: `log__item log__item--${run.status}` }, h("p", { class: "log__text" }, `${providerName(run.provider)}: ${run.kind.replace("-", " ")} ${run.subject.length > 20 ? "" : run.subject}`), h("p", { class: "log__meta" }, `${run.status} · ${relativeTime(run.updatedAt)}${run.message ? ` · ${run.message}` : ""}`)),
              ),
            ),
          )
        : null,
      h("h3", { class: "card__sub" }, "Studio"),
      activity.studio.length
        ? h("ol", { class: "log" }, activity.studio.map((event) => h("li", { class: "log__item" }, h("p", { class: "log__text" }, event.message), h("p", { class: "log__meta" }, relativeTime(event.at)))))
        : h("p", { class: "muted" }, "Nothing recorded yet."),
      h("h3", { class: "card__sub" }, "Engine log"),
      activity.engine.length
        ? h(
            "ol",
            { class: "log" },
            activity.engine.map((event) =>
              h(
                "li",
                { class: "log__item" },
                h("p", { class: "log__text" }, ENGINE_EVENTS[event.event] || event.event, event.details?.to ? ` to ${event.details.to}` : "", event.details?.stage ? `: ${event.details.stage}` : ""),
                h("p", { class: "log__meta" }, String(event.timestamp || event.at || "").replace("T", " ").replace("Z", " UTC")),
              ),
            ),
          )
        : h("p", { class: "muted" }, "The engine has not logged anything yet."),
    );
  } catch (error) {
    mount(body, errorState(error, () => renderActivity(drawer, ctx, close)));
  }
}
