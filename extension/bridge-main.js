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

  const redactUrl = (url) => {
    try {
      const parsed = new URL(String(url), location.origin);
      for (const key of [...parsed.searchParams.keys()]) {
        if (/authorization|token|cookie/i.test(key)) parsed.searchParams.set(key, "[REDACTED]");
      }
      return parsed.pathname + parsed.search;
    } catch {
      return String(url).replace(/([?&][^=]*(?:authorization|token|cookie)[^=]*=)[^&]*/gi, "$1[REDACTED]");
    }
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

  const postJson = async (endpoint, body, maxChars) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
      body: JSON.stringify(body || {})
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text: text.slice(0, maxChars || 120000)
    };
  };

  let yjsModulePromise;
  const loadYjs = async () => {
    yjsModulePromise ||= Promise.all([
      import("https://esm.sh/yjs@13.6.30"),
      import("https://esm.sh/y-websocket@1.5.4?deps=yjs@13.6.30")
    ]);
    const [Y, yWebsocket] = await yjsModulePromise;
    return { Y, WebsocketProvider: yWebsocket.WebsocketProvider };
  };

  const toYValue = (Y, value) => {
    if (Array.isArray(value)) {
      const array = new Y.Array();
      array.push(value.map((item) => toYValue(Y, item)));
      return array;
    }
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const map = new Y.Map();
      Object.entries(value).forEach(([key, item]) => map.set(key, toYValue(Y, item)));
      return map;
    }
    return value;
  };

  const withCanvasYjs = async (fn) => {
    const { Y, WebsocketProvider } = await loadYjs();
    const canvasId = location.pathname.split("/").filter(Boolean).pop();
    const token = localStorage.getItem("Rh-Accesstoken");
    if (!canvasId) throw new Error("canvasId not found in location");
    if (!token) throw new Error("Rh-Accesstoken not found");

    const detail = await fetch("/canvas/getCanvasDetail", {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
      body: JSON.stringify({ id: canvasId })
    }).then((response) => response.json());
    const userId = detail?.data?.user_id;
    if (!userId) throw new Error("user_id not found in canvas detail");

    const doc = new Y.Doc();
    const provider = new WebsocketProvider("wss://rhtv.runninghub.cn/canvas/ws", canvasId, doc, {
      params: { roomId: canvasId, userId, token, type: "canvas", yjsClientId: String(doc.clientID) }
    });
    try {
      const synced = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 10000);
        provider.on("sync", (isSynced) => {
          if (isSynced) {
            clearTimeout(timer);
            resolve(true);
          }
        });
      });
      if (!synced) throw new Error("Timed out waiting for Yjs sync");

      const root = doc.getMap("canvas");
      let content = root.get("canvas_content");
      if (!content) {
        content = new Y.Map();
        content.set("type", "canvas");
        root.set("canvas_content", content);
      }
      let nodes = content.get("nodes");
      if (!nodes) {
        nodes = new Y.Array();
        content.set("nodes", nodes);
      }
      let edges = content.get("edges");
      if (!edges) {
        edges = new Y.Array();
        content.set("edges", edges);
      }

      const value = await fn({ Y, doc, root, content, nodes, edges, canvasId, detail });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return value;
    } finally {
      provider.destroy();
      doc.destroy();
    }
  };

  const yArrayToJson = (array) => {
    if (!array) return [];
    return Array.isArray(array.toJSON?.()) ? array.toJSON() : [];
  };

  const createTextWorkflow = async (config = {}) =>
    withCanvasYjs(({ Y, doc, nodes, edges }) => {
      const currentNodes = yArrayToJson(nodes);
      const currentEdges = yArrayToJson(edges);
      const timestamp = Date.now();
      const suffix = Math.random().toString(36).slice(2, 10);
      const groupId = `group-${timestamp}-${suffix}`;
      const sourceId = `node-${timestamp}-${suffix}-source`;
      const targetId = `node-${timestamp}-${suffix}-target`;
      const edgeId = `e-${sourceId}-${targetId}`;
      const maxX = currentNodes.reduce((max, node) => Math.max(max, Number(node?.position?.x) || 0), 0);
      const baseX = Math.max(300, maxX + 420);
      const baseY = Number(config.y) || 300;
      const groupColor = config.groupColor || "rgba(75, 130, 180, 0.18)";
      const sourceTitle = config.sourceTitle || "API 输入节点";
      const targetTitle = config.targetTitle || "API 输出节点";

      const source = {
        id: sourceId,
        type: "rh-text",
        position: { x: baseX, y: baseY },
        zIndex: currentNodes.length + 1,
        style: {},
        selectable: true,
        data: {
          params: { prompt: "" },
          modelCode: "text-text-rhart-text-g-3-flash-preview",
          generateNum: 1,
          subType: "text-text",
          textModelListType: "text-text",
          title: sourceTitle,
          agentCreated: true,
          from: "bridge",
          agentNodeType: "copywriting",
          status: "idle",
          text: config.sourceText || "API 写入：上游文本节点",
          groupId,
          groupColor,
          addNewGroup: true,
          maxConnect: { image: null, text: null, video: null }
        }
      };
      const target = {
        id: targetId,
        type: "rh-text",
        position: { x: baseX + 520, y: baseY + 80 },
        zIndex: currentNodes.length + 2,
        style: {},
        selectable: true,
        data: {
          params: { prompt: "" },
          modelCode: "text-text-rhart-text-g-3-flash-preview",
          generateNum: 1,
          subType: "text-text",
          textModelListType: "text-text",
          title: targetTitle,
          agentCreated: true,
          from: "bridge",
          agentNodeType: "output",
          status: "idle",
          text: config.targetText || "API 写入：下游文本节点，已连接上游",
          inheritedFrom: sourceId,
          hasUpstream: true,
          groupId,
          groupColor,
          addNewGroup: true,
          maxConnect: { image: null, text: null, video: null }
        }
      };
      const group = {
        id: groupId,
        type: "group",
        position: { x: baseX - 60, y: baseY - 90 },
        zIndex: -1000,
        style: {},
        selectable: false,
        data: {
          title: "节点",
          groupName: config.groupName || "API 基础连线测试",
          groupColor,
          borderColor: "rgba(75, 130, 180, 0.65)",
          nodeIds: [sourceId, targetId],
          width: 960,
          height: 470,
          nodeOffsets: {
            [sourceId]: { x: 60, y: 90 },
            [targetId]: { x: 580, y: 170 }
          },
          status: "idle"
        }
      };
      const edge = {
        id: edgeId,
        source: sourceId,
        target: targetId,
        sourceHandle: "output",
        targetHandle: "input",
        type: "default",
        animated: false
      };

      doc.transact(() => {
        nodes.push([toYValue(Y, source), toYValue(Y, target), toYValue(Y, group)]);
        edges.push([toYValue(Y, edge)]);
      });

      return {
        canvasId: location.pathname.split("/").filter(Boolean).pop(),
        added: { nodes: [sourceId, targetId, groupId], edges: [edgeId] },
        before: { nodes: currentNodes.length, edges: currentEdges.length },
        after: { nodes: currentNodes.length + 3, edges: currentEdges.length + 1 }
      };
    });

  const updateNodeText = async ({ nodeId, text, title } = {}) => {
    if (!nodeId) throw new Error("nodeId is required");
    return withCanvasYjs(({ Y, doc, nodes }) => {
      let updated = false;
      doc.transact(() => {
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes.get(index);
          const nodeJson = node?.toJSON?.() || node;
          if (nodeJson?.id !== nodeId) continue;

          if (node instanceof Y.Map) {
            let data = node.get("data");
            if (!(data instanceof Y.Map)) {
              data = toYValue(Y, data || {});
              node.set("data", data);
            }
            if (text !== undefined) data.set("text", text);
            if (title !== undefined) data.set("title", title);
          } else {
            nodeJson.data ||= {};
            if (text !== undefined) nodeJson.data.text = text;
            if (title !== undefined) nodeJson.data.title = title;
            nodes.delete(index, 1);
            nodes.insert(index, [toYValue(Y, nodeJson)]);
          }
          updated = true;
          break;
        }
      });
      if (!updated) throw new Error(`Node not found: ${nodeId}`);
      return { updated: true, nodeId, text, title };
    });
  };

  const deleteElements = async ({ ids = [], nodeIds = [], edgeIds = [] } = {}) =>
    withCanvasYjs(({ nodes, edges }) => {
      const nodeSet = new Set([...ids, ...nodeIds].filter(Boolean));
      const edgeSet = new Set([...ids, ...edgeIds].filter(Boolean));
      let deletedNodes = 0;
      let deletedEdges = 0;

      for (let index = edges.length - 1; index >= 0; index--) {
        const edge = edges.get(index)?.toJSON?.() || edges.get(index);
        if (edgeSet.has(edge?.id) || nodeSet.has(edge?.source) || nodeSet.has(edge?.target)) {
          edges.delete(index, 1);
          deletedEdges++;
        }
      }
      for (let index = nodes.length - 1; index >= 0; index--) {
        const node = nodes.get(index)?.toJSON?.() || nodes.get(index);
        if (nodeSet.has(node?.id)) {
          nodes.delete(index, 1);
          deletedNodes++;
        }
      }
      return { deletedNodes, deletedEdges };
    });

  const executeCommand = async (command) => {
    if (!command || !command.id) return;
    let result;
    try {
      if (command.type === "graph.snapshot") {
        result = summarizeGraph();
      } else if (command.type === "canvas.exportWorkflow") {
        if (typeof window._exportWorkflow !== "function") throw new Error("window._exportWorkflow is not available");
        result = window._exportWorkflow();
      } else if (command.type === "canvas.yjsSnapshot") {
        result = await withCanvasYjs(({ nodes, edges, canvasId }) => ({
          canvasId,
          nodes: yArrayToJson(nodes),
          edges: yArrayToJson(edges)
        }));
      } else if (command.type === "canvas.createTextWorkflow") {
        result = await createTextWorkflow(command.config || {});
      } else if (command.type === "canvas.updateNodeText") {
        result = await updateNodeText(command);
      } else if (command.type === "canvas.deleteElements") {
        result = await deleteElements(command);
      } else if (command.type === "canvas.getDetail") {
        result = await postJson("/canvas/getCanvasDetail", command.body || { id: command.canvasId }, command.maxChars);
      } else if (command.type === "canvas.workflowList") {
        result = await postJson("/canvas/workflow/list", command.body || { canvasId: command.canvasId }, command.maxChars);
      } else if (command.type === "api.post") {
        result = await postJson(command.endpoint, command.body || {}, command.maxChars);
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
          url: redactUrl(url),
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
              url: redactUrl(url),
              status: response.status,
              ok: response.ok,
              text: text.slice(0, 240000)
            });
          })
          .catch((error) => {
            postEvent({
              kind: "fetch.response.error",
              requestId: requestRecord.requestId,
              url: redactUrl(url),
              error: String(error)
            });
          });
      } catch (error) {
        postEvent({
          kind: "fetch.response.error",
          requestId: requestRecord.requestId,
          url: redactUrl(url),
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
      rec.safeUrl = redactUrl(url);
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
            url: rec.safeUrl,
            status: xhr.status,
            text: String(xhr.responseText || "").slice(0, 240000)
          });
        });
      }
      return send.apply(xhr, arguments);
    };
    return xhr;
  };

  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = function PatchedWebSocket(url, protocols) {
    const safeUrl = redactUrl(url);
    postEvent({
      kind: "websocket.open",
      url: safeUrl,
      protocols: safeJson(protocols)
    });
    const ws = protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
    ws.addEventListener("open", () => postEvent({ kind: "websocket.status", url: safeUrl, status: "open" }));
    ws.addEventListener("close", (event) =>
      postEvent({ kind: "websocket.status", url: safeUrl, status: "close", code: event.code, reason: event.reason })
    );
    ws.addEventListener("error", () => postEvent({ kind: "websocket.status", url: safeUrl, status: "error" }));
    return ws;
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  Object.assign(window.WebSocket, OriginalWebSocket);

  window.__RUNNINGHUB_CANVAS_BRIDGE__ = {
    clientId: CLIENT_ID,
    graph: summarizeGraph,
    commands: [
      "graph.snapshot",
      "canvas.exportWorkflow",
      "canvas.yjsSnapshot",
      "canvas.createTextWorkflow",
      "canvas.updateNodeText",
      "canvas.deleteElements",
      "canvas.getDetail",
      "canvas.workflowList",
      "api.post",
      "page.eval"
    ]
  };

  postEvent({ kind: "bridge.installed", graph: summarizeGraph() });
  pollCommands();
})();
