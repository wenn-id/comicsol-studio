// DEMO backend for the GitHub Pages preview. Never part of the Python package.
//
// GitHub Pages cannot run Studio, so this script answers the console's /api/* requests
// inside the browser by replaying recording.json: a real session that pages/record.py
// drove through the actual Studio application and Comic Sol engine. It invents no engine
// output. A write that matches the next recorded step advances the replay; anything
// else is refused with a DEMO explanation. The DEMO panel can also step the replay.

(() => {
  const SITE = new URL("../", document.currentScript.src);
  const STUDIO = new URL("studio/", SITE);
  const STATE_KEY = "comicsol-studio:demo";
  const PANEL_KEY = "comicsol-studio:demo-panel";
  const ROUTE_KEY = "comicsol-studio:demo-route";
  const realFetch = window.fetch.bind(window);
  const onConsole = location.pathname.startsWith(STUDIO.pathname);

  // "Next step" loads the console shell at studio/ and leaves the stage route here, so
  // it never goes through GitHub Pages' 404 fallback. Set it before the console reads it.
  try {
    const pending = sessionStorage.getItem(ROUTE_KEY);
    sessionStorage.removeItem(ROUTE_KEY);
    if (onConsole && pending && pending.startsWith(STUDIO.pathname)) history.replaceState({}, "", pending);
  } catch {
    // Without storage the console simply opens where it was loaded.
  }

  const recording = realFetch(new URL("demo/recording.json", SITE)).then((response) => {
    if (!response.ok) throw new Error(`The demo recording is missing (${response.status}).`);
    return response.json();
  });

  let state = { step: 0, title: null };
  try {
    const saved = JSON.parse(sessionStorage.getItem(STATE_KEY) || "null");
    if (saved && Number.isInteger(saved.step)) state = { step: saved.step, title: saved.title ?? null };
  } catch {
    // Storage can be unavailable; the replay starts at the library.
  }
  function save() {
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch {
      // The replay still works for this page view.
    }
    renderPanel();
  }

  const json = (status, body) => new Response(body === null || status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
  const demoError = (status, message, hint) => json(status, { error: { code: "demo_preview", message, hint, details: [] } });

  // Recorded file URLs point at the Studio file routes; serve the recorded bytes as
  // static files next to this script instead. The query string is kept because the
  // console appends to it (for example "&download=1").
  function localize(rec, body) {
    let text = JSON.stringify(body);
    for (const [url, file] of Object.entries(rec.files)) {
      if (!text.includes(url)) continue;
      const query = url.includes("?") ? url.slice(url.indexOf("?")) : "";
      text = text.split(url).join(new URL(`demo/${file}`, SITE).pathname + query);
    }
    const value = JSON.parse(text);
    if (state.title) retitle(rec, value);
    return value;
  }

  function retitle(rec, value) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) if (item && item.id === rec.projectId && "title" in item) item.title = state.title;
  }

  function recorded(rec, ref) {
    const response = rec.responses[ref];
    return json(response.status, response.body === null ? null : localize(rec, response.body));
  }

  const nextStep = (rec) => rec.steps[state.step + 1] || null;

  function advance(rec) {
    const step = nextStep(rec);
    if (!step) return null;
    state.step += 1;
    save();
    return step;
  }

  function samePlan(left, right) {
    const canonical = (value) => JSON.stringify(value, (key, item) => (
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]]))
        : item
    ));
    return canonical(left) === canonical(right);
  }

  function currentProject(rec) {
    const ref = rec.steps[state.step].reads[`/api/projects/${rec.projectId}`];
    return ref ? rec.responses[ref].body : null;
  }

  async function route(method, url, init) {
    const rec = await recording;
    const path = url.pathname;
    const step = rec.steps[state.step];
    const projectBase = `/api/projects/${rec.projectId}`;

    if (method === "GET") {
      if (path === "/api/session") return json(200, rec.session);
      if (path === "/api/engine") return json(200, rec.engine);
      if (path === "/api/starters") return json(200, rec.starters);
      const ref = step.reads[path];
      if (ref) return recorded(rec, ref);
      if (path.startsWith("/api/projects/")) {
        return demoError(404, "That project does not exist in this preview.", "The DEMO replays one recorded project.");
      }
      return demoError(404, "This preview has no data for that request.", null);
    }

    const next = nextStep(rec);
    if (next && next.write.method === method && next.write.path === path) {
      if (method === "POST" && path === "/api/projects") {
        const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
        state.title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : null;
      }
      advance(rec);
      return recorded(rec, next.write.response);
    }

    if (method === "POST" && path === `${projectBase}/plan/validate`) {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      const saved = currentProject(rec)?.plan;
      const recordedPlan = rec.responses[rec.steps.find((item) => item.write?.path === `${projectBase}/plan`)?.write.response]?.body?.plan;
      const known = [saved, recordedPlan].some((plan) => plan && samePlan(
        { storyPlan: plan.storyPlan, characterBible: plan.characterBible, storyboard: plan.storyboard },
        { storyPlan: body.plan?.storyPlan, characterBible: body.plan?.characterBible, storyboard: body.plan?.storyboard },
      ));
      return json(200, {
        // No ": " in the text: the console reads that as "document path: message".
        issues: known ? [] : ["DEMO preview. The Comic Sol engine is not running here, so only the recorded plan can be checked. Use Next step in the DEMO panel to save it."],
      });
    }
    if (method === "PATCH" && path === projectBase && state.step > 0) {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      if (typeof body.title === "string" && body.title.trim()) state.title = body.title.trim();
      save();
      return json(200, localize(rec, currentProject(rec)));
    }
    if (method === "DELETE" && path === projectBase && state.step > 0) {
      state = { step: 0, title: null };
      save();
      return json(204, null);
    }

    if (path === "/api/projects/import" || path.endsWith("/exports/archive")) {
      return demoError(409, "DEMO: archives need a running Studio.", "The engine builds and checks .comic-sol-handoff archives on the machine that runs Studio. The finished PDF is available on the Finish page.");
    }

    const hint = next
      ? `Next recorded step: ${next.label}. Take that action, or use "Next step" in the DEMO panel.`
      : "The recorded session is complete. Use Restart in the DEMO panel to replay it.";
    return demoError(409, "DEMO: this action is not part of the recorded session.", hint);
  }

  window.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
    const method = String(init.method || request?.method || "GET").toUpperCase();
    // A short delay keeps the console's loading states visible, as over a network.
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));
    return route(method, url, init);
  };

  // DEMO panel ----------------------------------------------------------------------

  let panel = null;
  let total = 0;
  let labels = [];

  // A full load, not a soft refresh: the console rightly keeps unsaved plan drafts in
  // memory, and a replayed step must show the recorded state of the stage it belongs to.
  function openStage(rec) {
    if (!onConsole) return;
    const stage = rec.steps[state.step].stage;
    const projectPath = `${STUDIO.pathname}p/${rec.projectId}`;
    try {
      sessionStorage.setItem(ROUTE_KEY, stage === "library" ? STUDIO.pathname : `${projectPath}/${stage}`);
    } catch {
      // The shell still opens; the console shows the library.
    }
    location.assign(STUDIO.pathname);
  }

  async function stepForward() {
    const rec = await recording;
    if (!advance(rec)) return;
    openStage(rec);
  }

  function restart() {
    state = { step: 0, title: null };
    save();
    if (onConsole) location.assign(STUDIO.pathname);
  }

  function renderPanel() {
    if (!panel) return;
    const collapsed = panel.dataset.collapsed === "true";
    const done = state.step >= total;
    panel.querySelector("[data-demo-progress]").textContent = total ? `Step ${state.step} of ${total}` : "";
    panel.querySelector("[data-demo-now]").textContent = state.step ? `Done: ${labels[state.step]}` : "Start: an empty library.";
    panel.querySelector("[data-demo-next]").textContent = done ? "The recorded session is complete." : `Next: ${labels[state.step + 1]}`;
    const next = panel.querySelector('[data-demo="next"]');
    next.disabled = done;
    next.hidden = !onConsole;
    panel.querySelector('[data-demo="toggle"]').setAttribute("aria-expanded", String(!collapsed));
  }

  function mountPanel() {
    panel = document.createElement("aside");
    panel.className = "demo-panel";
    panel.setAttribute("aria-label", "DEMO preview");
    // One compact row by default so it never covers the work; the reviewer can open the
    // details, and the console remembers that choice.
    let saved = null;
    try {
      saved = localStorage.getItem(PANEL_KEY);
    } catch {
      saved = null;
    }
    panel.dataset.collapsed = onConsole && saved === "open" ? "false" : "true";
    panel.innerHTML = `
      <div class="demo-panel__head">
        <button type="button" class="demo-panel__toggle" data-demo="toggle" aria-controls="demo-panel-body">
          <span class="demo-panel__tag">DEMO</span>
          <span class="demo-panel__title">Preview build</span>
          <span class="demo-panel__progress" data-demo-progress></span>
        </button>
        <button type="button" class="demo-panel__step" data-demo="next">Next step</button>
      </div>
      <div class="demo-panel__body" id="demo-panel-body">
        <p>No server runs here. Studio replays a session recorded against the real Comic Sol engine with the Sunlight Courier sample. Uploads and reviews you enter use the recorded results.</p>
        <p class="demo-panel__now" data-demo-now></p>
        <p class="demo-panel__next" data-demo-next></p>
        <div class="demo-panel__actions">
          <button type="button" data-demo="restart">Restart</button>
        </div>
      </div>`;
    panel.querySelector('[data-demo="toggle"]').addEventListener("click", () => {
      panel.dataset.collapsed = panel.dataset.collapsed === "true" ? "false" : "true";
      try {
        if (onConsole) localStorage.setItem(PANEL_KEY, panel.dataset.collapsed === "true" ? "collapsed" : "open");
      } catch {
        // The choice lasts for this page view.
      }
      renderPanel();
    });
    panel.querySelector('[data-demo="next"]').addEventListener("click", () => void stepForward());
    panel.querySelector('[data-demo="restart"]').addEventListener("click", restart);
    document.body.append(panel);
    new ResizeObserver(() => {
      document.documentElement.style.setProperty("--demo-panel-height", `${panel.offsetHeight}px`);
    }).observe(panel);
    renderPanel();
    recording.then((rec) => {
      total = rec.steps.length - 1;
      labels = rec.steps.map((item) => item.label);
      renderPanel();
    }).catch((error) => {
      panel.querySelector("[data-demo-now]").textContent = error.message;
    });
  }

  if (document.body) mountPanel();
  else document.addEventListener("DOMContentLoaded", mountPanel, { once: true });
})();
