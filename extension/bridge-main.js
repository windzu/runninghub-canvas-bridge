(() => {
  if (window.__RUNNINGHUB_CANVAS_BRIDGE_INSTALLED__) return;
  window.__RUNNINGHUB_CANVAS_BRIDGE_INSTALLED__ = true;

  const BRIDGE = "http://127.0.0.1:8765";
  const CLIENT_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let seq = 0;

  const safeJson = (value) => {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  };

  const shouldCapture = (url) =>
    /openclaw|canvas\/workflow|canvas\/task|canvas\/getCanvasDetail|canvas\/create|canvas\/rename/i.test(String(url || ""));

  const redactHeaders = (headers) => {
    const out = {};
    try {
      const h = new Headers(headers || {});
      for (const [key, value] of h.entries()) {
        out[key] = /authorization|token|cookie/i.test(key) ? "[REDACTED]" : value;
      }
    } catch {}
    return out;
  };

  const postEvent = (event) => {
    const payload = {
      clientId: CLIENT_ID,
      seq: ++seq,
      ts: Date.now(),
      href: location.href,
      title: document.title,
      ...event
    };
    fetch(`${BRIDGE}/events`, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(() => {});
  };

  const authHeaders = () => {
    const headers = { "Content-Type": "application/json" };
    try {
      const token = localStorage.getItem("Rh-Accesstoken");
      if (token) headers.Authorization = `Bearer ${token}`;
    } catch {}
    return headers;
  };

  const summarizeGraph = () => ({
    canvasId: location.pathname.split("/").filter(Boolean).pop(),
    nodes: Array.from(document.querySelectorAll(".vue-flow__node")).map((el) => ({
      dataId: el.getAttribute("data-id"),
      className: String(el.className),
      text: (el.innerText || el.textContent || "").trim().slice(0, 500),
      rect: (() => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()
    })),
    edges: Array.from(document.querySelectorAll(".vue-flow__edge")).map((el) => ({
      dataId: el.getAttribute("data-id"),
      className: String(el.className)
    }))
  });

  const executeCommand = async (command) => {
    if (!command || !command.id) return;
    let result;
    try {
      if (command.type === "graph.snapshot") {
        result = summarizeGraph();
      } else if (command.type === "api.post") {
        const response = await fetch(command.endpoint, {
          method: "POST",
          headers: authHeaders(),
          credentials: "include",
          body: JSON.stringify(command.body || {})
        });
        const text = await response.text();
        result = {
          ok: response.ok,
          status: response.status,
          text: text.slice(0, command.maxChars || 120000)
        };
      } else if (command.type === "page.eval") {
        const fn = new Function("arg", command.code);
        result = await fn(command.arg);
      } else {
        throw new Error(`Unknown command type: ${command.type}`);
      }
      postEvent({ kind: "command.result", commandId: command.id, ok: true, result: safeJson(result) });
    } catch (error) {
      postEvent({
        kind: "command.result",
        commandId: command.id,
        ok: false,
        error: error && error.stack ? error.stack : String(error)
      });
    }
  };

  const pollCommands = async () => {
    try {
      const response = await fetch(`${BRIDGE}/commands?clientId=${encodeURIComponent(CLIENT_ID)}&href=${encodeURIComponent(location.href)}`, {
        mode: "cors"
      });
      if (response.ok) {
        const commands = await response.json();
        for (const command of commands) await executeCommand(command);
      }
    } catch {}
    setTimeout(pollCommands, 700);
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    const capture = shouldCapture(url);
    const requestRecord = capture
      ? {
          kind: "fetch.request",
          requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          url: String(url),
          method: (init && init.method) || (input && input.method) || "GET",
          headers: redactHeaders((init && init.headers) || (input && input.headers)),
          body: init && typeof init.body === "string" ? init.body.slice(0, 60000) : undefined
        }
      : null;
    if (requestRecord) postEvent(requestRecord);
    const response = await originalFetch(input, init);
    if (requestRecord) {
      try {
        response
          .clone()
          .text()
          .then((text) => {
            postEvent({
              kind: "fetch.response",
              requestId: requestRecord.requestId,
              url: String(url),
              status: response.status,
              ok: response.ok,
              text: text.slice(0, 240000)
            });
          })
          .catch((error) => {
            postEvent({
              kind: "fetch.response.error",
              requestId: requestRecord.requestId,
              url: String(url),
              error: String(error)
            });
          });
      } catch (error) {
        postEvent({
          kind: "fetch.response.error",
          requestId: requestRecord.requestId,
          url: String(url),
          error: String(error)
        });
      }
    }
    return response;
  };

  const OriginalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function PatchedXMLHttpRequest() {
    const xhr = new OriginalXHR();
    const rec = { kind: "xhr.request", headers: {}, requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
    const open = xhr.open;
    xhr.open = function openPatched(method, url) {
      rec.method = method;
      rec.url = String(url);
      rec.capture = shouldCapture(url);
      return open.apply(xhr, arguments);
    };
    const setRequestHeader = xhr.setRequestHeader;
    xhr.setRequestHeader = function setRequestHeaderPatched(key, value) {
      rec.headers[key] = /authorization|token|cookie/i.test(key) ? "[REDACTED]" : value;
      return setRequestHeader.apply(xhr, arguments);
    };
    const send = xhr.send;
    xhr.send = function sendPatched(body) {
      if (rec.capture) {
        if (typeof body === "string") rec.body = body.slice(0, 60000);
        postEvent(rec);
        xhr.addEventListener("loadend", () => {
          postEvent({
            kind: "xhr.response",
            requestId: rec.requestId,
            url: rec.url,
            status: xhr.status,
            text: String(xhr.responseText || "").slice(0, 240000)
          });
        });
      }
      return send.apply(xhr, arguments);
    };
    return xhr;
  };

  window.__RUNNINGHUB_CANVAS_BRIDGE__ = {
    clientId: CLIENT_ID,
    graph: summarizeGraph
  };

  postEvent({ kind: "bridge.installed", graph: summarizeGraph() });
  pollCommands();
})();
