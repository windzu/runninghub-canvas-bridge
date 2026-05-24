(() => {
  const RUNTIME_VERSION = window.__RUNNINGHUB_CANVAS_BRIDGE_EXPECTED_VERSION__ || "dev";
  if (window.__RUNNINGHUB_CANVAS_BRIDGE_INSTALLED__) {
    if (window.__RUNNINGHUB_CANVAS_BRIDGE_VERSION__ === RUNTIME_VERSION) return;
    try {
      window.__RUNNINGHUB_CANVAS_BRIDGE_CLEANUP__?.();
    } catch {}
  }
  window.__RUNNINGHUB_CANVAS_BRIDGE_INSTALLED__ = true;
  window.__RUNNINGHUB_CANVAS_BRIDGE_VERSION__ = RUNTIME_VERSION;

  const BRIDGE = "http://127.0.0.1:8765";
  const CLIENT_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let seq = 0;
  let pollTimer;
  let originalFetch;
  let OriginalXHR;
  let OriginalWebSocket;

  const safeJson = (value) => {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  };

  const errorCodeFromError = (error) => {
    const message = String(error?.message || error || "");
    if (/Node not found|Element not found/i.test(message)) return "NODE_NOT_FOUND";
    if (/Rendered node not found/i.test(message)) return "NO_RENDERED_NODE";
    if (/No image input accepted file/i.test(message)) return "UPLOAD_INPUT_NOT_FOUND";
    if (/Timed out/i.test(message)) return "TIMEOUT";
    if (/validation failed|VALIDATION_FAILED/i.test(message)) return "VALIDATION_FAILED";
    if (/sourceUrl is required|url is required/i.test(message)) return "MISSING_REQUIRED_FIELD";
    if (/Rh-Accesstoken/i.test(message)) return "AUTH_TOKEN_NOT_FOUND";
    return "COMMAND_FAILED";
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
      runtimeVersion: RUNTIME_VERSION,
      runtimeCommands: window.__RUNNINGHUB_CANVAS_BRIDGE__?.commands,
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

  const parseJsonText = (text) => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };

  const taskInfoFromRunResponse = (response) => {
    const body = parseJsonText(response?.text);
    return {
      ok: Boolean(response?.ok && body?.code === 0),
      httpStatus: response?.status,
      code: body?.code,
      msg: body?.msg,
      taskId: body?.data?.taskId,
      status: body?.data?.status,
      nodeCount: body?.data?.nodeCount,
      targetType: body?.data?.targetType,
      targetName: body?.data?.targetName
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

  const rollbackStack = [];

  const canvasSnapshotFromContext = ({ nodes, edges, canvasId }) => ({
    canvasId,
    nodes: yArrayToJson(nodes),
    edges: yArrayToJson(edges)
  });

  const diffById = (beforeItems, afterItems) => {
    const before = new Map(beforeItems.map((item) => [item?.id, item]).filter(([id]) => id));
    const after = new Map(afterItems.map((item) => [item?.id, item]).filter(([id]) => id));
    const added = [];
    const removed = [];
    const updated = [];

    for (const [id, item] of after.entries()) {
      if (!before.has(id)) {
        added.push(id);
        continue;
      }
      const beforeJson = JSON.stringify(before.get(id));
      const afterJson = JSON.stringify(item);
      if (beforeJson !== afterJson) {
        updated.push({ id, before: before.get(id), after: item });
      }
    }
    for (const id of before.keys()) {
      if (!after.has(id)) removed.push(id);
    }
    return {
      added,
      removed,
      updated,
      counts: { added: added.length, removed: removed.length, updated: updated.length }
    };
  };

  const diffCanvasSnapshots = (before, after) => ({
    nodes: diffById(before.nodes || [], after.nodes || []),
    edges: diffById(before.edges || [], after.edges || []),
    before: { nodes: before.nodes?.length || 0, edges: before.edges?.length || 0 },
    after: { nodes: after.nodes?.length || 0, edges: after.edges?.length || 0 }
  });

  const makePreviewContext = (Y, snapshot) => {
    const doc = new Y.Doc();
    const root = doc.getMap("canvas");
    const content = new Y.Map();
    const nodes = new Y.Array();
    const edges = new Y.Array();
    nodes.push((snapshot.nodes || []).map((node) => toYValue(Y, node)));
    edges.push((snapshot.edges || []).map((edge) => toYValue(Y, edge)));
    content.set("type", "canvas");
    content.set("nodes", nodes);
    content.set("edges", edges);
    root.set("canvas_content", content);
    return { Y, doc, root, content, nodes, edges, canvasId: snapshot.canvasId, preview: true };
  };

  const rememberRollback = ({ command, before, after, diff }) => {
    const rollbackId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    rollbackStack.unshift({
      rollbackId,
      commandId: command.id,
      commandType: command.type,
      href: location.href,
      ts: Date.now(),
      before,
      after,
      diff
    });
    if (rollbackStack.length > 20) rollbackStack.splice(20);
    return rollbackId;
  };

  const withCanvasMutation = async (command, mutate) =>
    withCanvasYjs(async (ctx) => {
      const before = canvasSnapshotFromContext(ctx);
      if (command.dryRun) {
        const preview = makePreviewContext(ctx.Y, before);
        let value;
        try {
          value = await mutate(preview);
          const after = canvasSnapshotFromContext(preview);
          return {
            dryRun: true,
            applied: false,
            result: value,
            diff: diffCanvasSnapshots(before, after)
          };
        } finally {
          preview.doc.destroy();
        }
      }

      const value = await mutate(ctx);
      const after = canvasSnapshotFromContext(ctx);
      const diff = diffCanvasSnapshots(before, after);
      const rollbackId = rememberRollback({ command, before, after, diff });
      return {
        dryRun: false,
        applied: true,
        rollbackId,
        result: value,
        diff
      };
    });

  const replaceCanvasSnapshot = async ({ snapshot } = {}) => {
    if (!snapshot || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) {
      throw new Error("snapshot with nodes and edges is required");
    }
    return withCanvasYjs(({ Y, doc, nodes, edges, canvasId }) => {
      const before = { canvasId, nodes: yArrayToJson(nodes), edges: yArrayToJson(edges) };
      doc.transact(() => {
        if (edges.length) edges.delete(0, edges.length);
        if (nodes.length) nodes.delete(0, nodes.length);
        nodes.push(snapshot.nodes.map((node) => toYValue(Y, node)));
        edges.push(snapshot.edges.map((edge) => toYValue(Y, edge)));
      });
      const after = { canvasId, nodes: yArrayToJson(nodes), edges: yArrayToJson(edges) };
      return { applied: true, diff: diffCanvasSnapshots(before, after) };
    });
  };

  const rollbackCanvas = async ({ rollbackId } = {}) => {
    const entry = rollbackId ? rollbackStack.find((item) => item.rollbackId === rollbackId) : rollbackStack[0];
    if (!entry) throw new Error(rollbackId ? `Rollback not found: ${rollbackId}` : "No rollback entry available");
    const result = await replaceCanvasSnapshot({ snapshot: entry.before });
    return { rollbackId: entry.rollbackId, commandId: entry.commandId, commandType: entry.commandType, ...result };
  };

  const COMMAND_CAPABILITIES = [
    {
      type: "graph.snapshot",
      description: "Read DOM-level Vue Flow nodes and edges from the visible page."
    },
    {
      type: "canvas.yjsSnapshot",
      description: "Read canonical Yjs canvas nodes and edges."
    },
    {
      type: "canvas.summary",
      description: "Return a compact Agent-oriented canvas summary with node status, media URLs, and connection counts."
    },
    {
      type: "canvas.rollbackList",
      description: "List recent rollback points created by mutating commands."
    },
    {
      type: "canvas.rollback",
      description: "Restore the canvas to a previous rollback point. Uses the latest point by default."
    },
    {
      type: "canvas.restoreSnapshot",
      description: "Restore nodes and edges from an explicit snapshot."
    },
    {
      type: "canvas.findElements",
      description: "Find nodes and edges by id, type, text/title query, or position bounds.",
      params: {
        kind: "all | nodes | edges",
        q: "case-insensitive text query over node title/text/type/id and edge id/source/target",
        ids: "array of node or edge ids",
        type: "node or edge type",
        bounds: "{ xMin, xMax, yMin, yMax } for node positions",
        includeEdges: "when kind is nodes, include edges connected to matched nodes"
      }
    },
    {
      type: "canvas.getElement",
      description: "Return one node or edge by id."
    },
    {
      type: "canvas.inspectNodeTemplate",
      description: "Extract a reusable create-node template from one existing canvas node."
    },
    {
      type: "canvas.getConnections",
      description: "Return upstream/downstream node and edge relationships for one or more nodes."
    },
    {
      type: "canvas.createTextNode",
      description: "Create one rh-text node. Supports dryRun."
    },
    {
      type: "canvas.createTextNodes",
      description: "Create multiple rh-text nodes as one canvas mutation with one rollback id. Supports dryRun."
    },
    {
      type: "canvas.suggestEmptyRegion",
      description: "Suggest a conservative empty canvas region near matching text, around a node, or beyond existing content."
    },
    {
      type: "canvas.groupElements",
      description: "Create a group around explicitly provided node ids. Supports dryRun."
    },
    {
      type: "canvas.createNode",
      description: "Create one generic canvas node from a provided node template, type, position, and data. Supports dryRun."
    },
    {
      type: "canvas.createVideoNode",
      description: "Create one RunningHub native text-to-video rh-video node. Supports dryRun and optional upstream connection."
    },
    {
      type: "canvas.createImageNode",
      description: "Create one RunningHub native text-to-image rh-image node. Supports dryRun."
    },
    {
      type: "canvas.createReferenceImageNode",
      description: "Create one uploaded/reference rh-image node with sourceObjects and optionally connect it to a target node. Supports dryRun."
    },
    {
      type: "canvas.createReferenceFromUrl",
      description: "Create a directly usable reference image node from an existing image URL and return primaryReference."
    },
    {
      type: "canvas.uploadReferenceImage",
      description: "Inject a local image file payload into the selected/target RunningHub image input so the page uploads it and creates the native reference image node."
    },
    {
      type: "canvas.uploadLocalReferenceImage",
      description: "Agent-friendly one-shot local image upload: create a staging image node, inject the file, and return directly usable reference nodes and URLs."
    },
    {
      type: "canvas.runNode",
      description: "Call /canvas/task/run for one node using its upstream connected subgraph."
    },
    {
      type: "canvas.pollNodeResult",
      description: "Poll one canvas node until it has outputs or reaches a terminal status."
    },
    {
      type: "canvas.pollTaskResult",
      description: "Poll the canvas for outputs matching a RunningHub taskId."
    },
    {
      type: "canvas.prepareVideoNode",
      description: "Agent-friendly video preparation: collect upstream text and image outputs into effective rh-video params without generating."
    },
    {
      type: "canvas.validateVideoRun",
      description: "Validate that an rh-video node has effective prompt, multimodal model settings, imageUrls, and matching upstream image edges before paid generation."
    },
    {
      type: "canvas.validateNodeRun",
      description: "Generic pre-run validation for text, image, and video nodes."
    },
    {
      type: "canvas.generateVideoNode",
      description: "Safe high-level video generation: prepare upstream text/image inputs, validate references, then run the video node."
    },
    {
      type: "canvas.inspectModelOptions",
      description: "Return currently known model options and parameter schema notes for a node type or subType."
    },
    {
      type: "canvas.resolveModelAlias",
      description: "Resolve a user-facing model name to the observed RunningHub model name and modelCode."
    },
    {
      type: "canvas.updateNodeModel",
      description: "Update one node's modelCode and optional model metadata. Supports dryRun."
    },
    {
      type: "canvas.updateNodeParams",
      description: "Merge parameter values into one node's data.params. Supports dryRun."
    },
    {
      type: "canvas.createTextWorkflow",
      description: "Create a minimal two-node text workflow with one group and one edge. Supports dryRun."
    },
    {
      type: "canvas.connectNodes",
      description: "Create an edge between two existing nodes. Supports dryRun."
    },
    {
      type: "canvas.updateNode",
      description: "Update a node's position, data, style, zIndex, dimensions, title, or text. Supports dryRun."
    },
    {
      type: "canvas.updateNodePosition",
      description: "Move one node to an absolute x/y position. Supports dryRun."
    },
    {
      type: "canvas.moveNodes",
      description: "Move multiple nodes by delta or explicit positions. Supports dryRun."
    },
    {
      type: "canvas.updateNodeText",
      description: "Update a text node's data.text and optional data.title. Supports dryRun."
    },
    {
      type: "canvas.deleteElements",
      description: "Delete nodes, groups, and edges by id. Edges connected to deleted nodes are removed too. Supports dryRun."
    },
    {
      type: "canvas.getDetail",
      description: "Call /canvas/getCanvasDetail inside the logged-in page context."
    },
    {
      type: "canvas.workflowList",
      description: "Call /canvas/workflow/list inside the logged-in page context."
    },
    {
      type: "api.post",
      description: "Run an arbitrary POST inside the logged-in page context."
    },
    {
      type: "page.eval",
      description: "Dangerous local debugging hook. Keep local-only."
    }
  ];

  const getNodeTitle = (node) => String(node?.data?.title || node?.data?.groupName || node?.label || "");
  const getNodeText = (node) => String(node?.data?.text || node?.data?.params?.prompt || node?.text || "");
  const normalizeQuery = (value) => String(value || "").trim().toLowerCase();

  const MODEL_OPTIONS = {
    "text-image": {
      nodeType: "rh-image",
      defaultModelCode: "text-image-rhart-image-g-2-official-text-to-image",
      defaultRunningHubModelName: "全能图片G2-官方稳定版",
      params: {
        prompt: "string",
        aspectRatio: "string|null",
        quality: "low | medium | high, observed default medium",
        resolution: "observed default 1k"
      },
      observedModels: [
        "全能图片G2-官方稳定版",
        "全能图片G2-低价渠道版",
        "全能图片V2-低价渠道版",
        "全能图片V2-官方稳定版",
        "全能图片Pro-低价渠道版",
        "全能图片Pro-官方稳定版",
        "全能图片V1-低价渠道版",
        "全能图片G1.5-官方稳定版",
        "全能图片X-官方稳定版",
        "全能图片X-高质量-官方稳定版",
        "全能图片X-低价渠道版",
        "z-image-turbo",
        "万相2.5",
        "Seedream-V4",
        "Seedream-V4.5",
        "Seedream-V5-Lite"
      ]
    },
    "text-video": {
      nodeType: "rh-video",
      defaultModelCode: "text-video-sparkvideo-2.0",
      defaultRunningHubModelName: "Seedance2.0",
      params: {
        prompt: "string",
        resolution: "observed default 480p",
        duration: "observed default 5",
        generateAudio: "boolean",
        ratio: "string|null",
        webSearch: "boolean"
      },
      observedModels: ["Seedance2.0"]
    },
    "multimodal-video": {
      nodeType: "rh-video",
      defaultModelCode: "multimodal-video-sparkvideo-2.0",
      defaultRunningHubModelName: "Seedance2.0",
      params: {
        prompt: "string",
        imageUrls: "string[]",
        conversionSlots: "string[]",
        resolution: "observed default 720p",
        duration: "observed default 5",
        generateAudio: "boolean",
        ratio: "string|null"
      },
      observedModels: ["Seedance2.0"]
    }
  };

  const MODEL_ALIASES = {
    "gpt image 2": {
      subType: "text-image",
      requestedModelName: "GPT Image 2",
      runningHubModelName: "全能图片G2-官方稳定版",
      modelCode: "text-image-rhart-image-g-2-official-text-to-image",
      mappingStatus: "observed-ui-alias"
    },
    "gpt-image-2": {
      subType: "text-image",
      requestedModelName: "GPT Image 2",
      runningHubModelName: "全能图片G2-官方稳定版",
      modelCode: "text-image-rhart-image-g-2-official-text-to-image",
      mappingStatus: "observed-ui-alias"
    },
    "全能图片g2-官方稳定版": {
      subType: "text-image",
      requestedModelName: "全能图片G2-官方稳定版",
      runningHubModelName: "全能图片G2-官方稳定版",
      modelCode: "text-image-rhart-image-g-2-official-text-to-image",
      mappingStatus: "exact-observed-ui-name"
    },
    "seedance 2.0": {
      subType: "text-video",
      requestedModelName: "Seedance 2.0",
      runningHubModelName: "Seedance2.0",
      modelCode: "text-video-sparkvideo-2.0",
      mappingStatus: "observed-ui-alias"
    },
    "seedance 2.0 720p": {
      subType: "text-video",
      requestedModelName: "Seedance 2.0 720p",
      runningHubModelName: "Seedance2.0",
      modelCode: "text-video-sparkvideo-2.0",
      params: { resolution: "720p" },
      mappingStatus: "observed-ui-alias"
    },
    "seedance2.0": {
      subType: "text-video",
      requestedModelName: "Seedance2.0",
      runningHubModelName: "Seedance2.0",
      modelCode: "text-video-sparkvideo-2.0",
      mappingStatus: "exact-observed-ui-name"
    }
  };

  const normalizeModelName = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[-_]+/g, " ")
      .replace(/([a-z])(\d)/g, "$1 $2")
      .replace(/\s+/g, " ");

  const resolveModelAlias = ({ modelName, modelCode, subType } = {}) => {
    const alias = MODEL_ALIASES[normalizeModelName(modelName)];
    if (alias && (!subType || alias.subType === subType)) return alias;
    if (modelCode) {
      return {
        subType,
        requestedModelName: modelName,
        runningHubModelName: modelName,
        modelCode,
        mappingStatus: "explicit-model-code"
      };
    }
    const defaults = subType && MODEL_OPTIONS[subType];
    if (defaults) {
      return {
        subType,
        requestedModelName: modelName,
        runningHubModelName: defaults.defaultRunningHubModelName,
        modelCode: defaults.defaultModelCode,
        mappingStatus: alias ? "alias-subtype-mismatch-used-subtype-default" : modelName ? "fallback-default-for-subtype" : "default-for-subtype"
      };
    }
    return null;
  };

  const withinBounds = (node, bounds = {}) => {
    if (!bounds || typeof bounds !== "object") return true;
    const x = Number(node?.position?.x);
    const y = Number(node?.position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (bounds.xMin !== undefined && x < Number(bounds.xMin)) return false;
    if (bounds.xMax !== undefined && x > Number(bounds.xMax)) return false;
    if (bounds.yMin !== undefined && y < Number(bounds.yMin)) return false;
    if (bounds.yMax !== undefined && y > Number(bounds.yMax)) return false;
    return true;
  };

  const matchElement = (element, query = {}, kind) => {
    const ids = new Set([...(query.ids || []), query.id].filter(Boolean).map(String));
    if (ids.size && !ids.has(String(element?.id))) return false;
    if (query.type && String(element?.type || "") !== String(query.type)) return false;
    if (kind === "nodes" && query.bounds && !withinBounds(element, query.bounds)) return false;

    const q = normalizeQuery(query.q || query.text || query.title);
    if (!q) return true;
    const haystack =
      kind === "edges"
        ? [element?.id, element?.type, element?.source, element?.target, element?.sourceHandle, element?.targetHandle]
        : [element?.id, element?.type, getNodeTitle(element), getNodeText(element), element?.data?.agentNodeType, element?.data?.modelCode];
    return haystack.some((part) => normalizeQuery(part).includes(q));
  };

  const findElementsInSnapshot = ({ nodes, edges }, query = {}) => {
    const kind = query.kind || "all";
    const matchedNodes = kind === "edges" ? [] : nodes.filter((node) => matchElement(node, query, "nodes"));
    const matchedNodeIds = new Set(matchedNodes.map((node) => node.id));
    const matchedEdges =
      kind === "nodes"
        ? query.includeEdges
          ? edges.filter((edge) => matchedNodeIds.has(edge?.source) || matchedNodeIds.has(edge?.target))
          : []
        : edges.filter((edge) => matchElement(edge, query, "edges"));
    return {
      nodes: matchedNodes,
      edges: matchedEdges,
      counts: { nodes: matchedNodes.length, edges: matchedEdges.length }
    };
  };

  const pickFields = (value, fields) => {
    if (!Array.isArray(fields) || !fields.length) return value;
    const out = {};
    for (const field of fields) {
      if (field in value) out[field] = value[field];
    }
    return out;
  };

  const parseFields = (fields) =>
    Array.isArray(fields)
      ? fields.map(String).filter(Boolean)
      : String(fields || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);

  const compactNodeSummary = (node, { includeUrls = false, includeTextPreview = true, textPreviewLength = 120, fields } = {}) => {
    const outputs = outputUrlsFromNode(node);
    const sourceUrls = imageUrlsFromNode(node);
    const summary = {
      id: node.id,
      type: node.type,
      title: getNodeTitle(node),
      subType: node.data?.subType,
      status: node.data?.status,
      position: node.position,
      zIndex: node.zIndex,
      modelCode: node.data?.modelCode,
      taskId: node.data?.taskId || outputs.find((item) => item.taskId)?.taskId,
      outputCount: outputs.length,
      sourceUrlCount: sourceUrls.length,
      outputs: includeUrls ? outputs : undefined,
      sourceUrls: includeUrls ? sourceUrls : undefined,
      textPreview: includeTextPreview ? textFromNode(node).slice(0, Number(textPreviewLength) || 120) : undefined
    };
    return pickFields(summary, parseFields(fields));
  };

  const compactEdgeSummary = (edge, { fields } = {}) =>
    pickFields(
      {
        id: edge.id,
        type: edge.type,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle
      },
      parseFields(fields)
    );

  const canvasCapabilities = () => ({
    bridgeVersion: 1,
    clientId: CLIENT_ID,
    href: location.href,
    commands: COMMAND_CAPABILITIES
  });

  const summarizeCanvas = async ({ includeUrls = false, includeTextPreview = true, compact = true, full = false, limit, types, status, fields, textPreviewLength = 120 } = {}) =>
    withCanvasYjs(({ nodes, edges, canvasId }) => {
      const currentNodes = yArrayToJson(nodes);
      const currentEdges = yArrayToJson(edges);
      const typeSet = types ? new Set(String(types).split(",").map((item) => item.trim()).filter(Boolean)) : null;
      const statusSet = status ? new Set(String(status).split(",").map((item) => item.trim()).filter(Boolean)) : null;
      const upstreamCounts = new Map();
      const downstreamCounts = new Map();
      for (const edge of currentEdges) {
        if (edge?.target) upstreamCounts.set(edge.target, (upstreamCounts.get(edge.target) || 0) + 1);
        if (edge?.source) downstreamCounts.set(edge.source, (downstreamCounts.get(edge.source) || 0) + 1);
      }
      const nodeSummaries = currentNodes.filter((node) => {
        if (typeSet && !typeSet.has(String(node.type || ""))) return false;
        if (statusSet && !statusSet.has(String(node.data?.status || "unknown"))) return false;
        return true;
      }).map((node) => {
        const outputs = outputUrlsFromNode(node);
        const sourceUrls = imageUrlsFromNode(node);
        const summary = {
          id: node.id,
          type: node.type,
          title: getNodeTitle(node),
          subType: node.data?.subType,
          modelCode: node.data?.modelCode,
          status: node.data?.status,
          taskId: node.data?.taskId || outputs.find((item) => item.taskId)?.taskId,
          position: node.position,
          upstream: upstreamCounts.get(node.id) || 0,
          downstream: downstreamCounts.get(node.id) || 0,
          outputCount: Array.isArray(node.data?.output) ? node.data.output.length : 0,
          outputs: includeUrls ? outputs : undefined,
          sourceUrls: includeUrls ? sourceUrls : undefined,
          textPreview: includeTextPreview ? textFromNode(node).slice(0, Number(textPreviewLength) || 120) : undefined
        };
        return pickFields(summary, parseFields(fields));
      });
      const effectiveLimit = Number.isFinite(Number(limit)) && Number(limit) >= 0 ? Number(limit) : !full && compact ? 50 : undefined;
      const limitedNodes = effectiveLimit === undefined ? nodeSummaries : nodeSummaries.slice(0, effectiveLimit);
      const byType = {};
      const byStatus = {};
      for (const node of currentNodes) {
        byType[node.type || "unknown"] = (byType[node.type || "unknown"] || 0) + 1;
        byStatus[node.data?.status || "unknown"] = (byStatus[node.data?.status || "unknown"] || 0) + 1;
      }
      const result = {
        ok: true,
        canvasId,
        compact: !full && Boolean(compact),
        counts: { nodes: currentNodes.length, edges: currentEdges.length, byType, byStatus, matchedNodes: nodeSummaries.length, returnedNodes: limitedNodes.length },
        nodes: !full && Boolean(compact) && effectiveLimit === 0 ? undefined : limitedNodes,
        edges: full ? currentEdges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: edge.type })) : undefined,
        truncated: effectiveLimit !== undefined && nodeSummaries.length > limitedNodes.length,
        nextActions: []
      };
      return result;
    });

  const findElements = async (query = {}) =>
    withCanvasYjs(({ nodes, edges, canvasId }) => {
      const matches = findElementsInSnapshot({ nodes: yArrayToJson(nodes), edges: yArrayToJson(edges) }, query);
      const limit = Number.isFinite(Number(query.limit)) ? Number(query.limit) : undefined;
      const summary = query.summary || query.compact || query.fields || query.noOutputs || query.noParams || query.textPreviewLength;
      const nodeMatches = summary
        ? matches.nodes.map((node) =>
            compactNodeSummary(node, {
              includeUrls: !query.noOutputs && query.includeUrls,
              includeTextPreview: query.includeTextPreview !== false,
              textPreviewLength: query.textPreviewLength,
              fields: query.fields
            })
          )
        : matches.nodes;
      const edgeMatches = summary ? matches.edges.map((edge) => compactEdgeSummary(edge, { fields: query.edgeFields })) : matches.edges;
      return {
        canvasId,
        query,
        counts: matches.counts,
        nodes: limit === undefined ? nodeMatches : nodeMatches.slice(0, limit),
        edges: limit === undefined ? edgeMatches : edgeMatches.slice(0, limit),
        limited: limit !== undefined
      };
    });

  const getElement = async ({ id } = {}) => {
    if (!id) throw new Error("id is required");
    return withCanvasYjs(({ nodes, edges, canvasId }) => {
      const node = yArrayToJson(nodes).find((item) => item?.id === id);
      if (node) return { canvasId, kind: "node", element: node };
      const edge = yArrayToJson(edges).find((item) => item?.id === id);
      if (edge) return { canvasId, kind: "edge", element: edge };
      throw new Error(`Element not found: ${id}`);
    });
  };

  const nodeBounds = (node, padding = 0) => {
    const x = Number(node?.position?.x) || 0;
    const y = Number(node?.position?.y) || 0;
    const width = Number(node?.width || node?.data?.width || node?.style?.width || 360);
    const height = Number(node?.height || node?.data?.height || node?.style?.height || 240);
    return { x: x - padding, y: y - padding, width: width + padding * 2, height: height + padding * 2 };
  };

  const rectsOverlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  const suggestEmptyRegion = async ({ nearText, aroundNode, direction = "right-down", width = 1800, height = 800, padding = 300, stepX, stepY, maxAttempts = 80 } = {}) =>
    withCanvasYjs(({ nodes, edges, canvasId }) => {
      const currentNodes = yArrayToJson(nodes).filter((node) => node?.type !== "group");
      const currentEdges = yArrayToJson(edges);
      const paddedBounds = currentNodes.map((node) => ({ node, bounds: nodeBounds(node, Number(padding) || 0) }));
      const textQuery = normalizeQuery(nearText);
      const textMatches = textQuery
        ? currentNodes.filter((node) => normalizeQuery([node.id, getNodeTitle(node), textFromNode(node)].join(" ")).includes(textQuery))
        : [];
      const anchor =
        (aroundNode && currentNodes.find((node) => node.id === aroundNode)) ||
        textMatches[0] ||
        currentNodes.reduce((best, node) => ((Number(node?.position?.x) || 0) > (Number(best?.position?.x) || -Infinity) ? node : best), null);
      const anchorBounds = anchor ? nodeBounds(anchor, 0) : { x: 300, y: 300, width: 0, height: 0 };
      const dir = String(direction || "right-down");
      const xSign = dir.includes("left") ? -1 : 1;
      const ySign = dir.includes("up") ? -1 : 1;
      const baseX = xSign > 0 ? anchorBounds.x + anchorBounds.width + Number(padding) : anchorBounds.x - Number(width) - Number(padding);
      const baseY = ySign > 0 ? anchorBounds.y + Number(padding) : anchorBounds.y - Number(height) - Number(padding);
      const dx = Number(stepX) || Number(width) + Number(padding);
      const dy = Number(stepY) || Number(height) + Number(padding);
      let region = null;
      for (let attempt = 0; attempt < Number(maxAttempts); attempt++) {
        const ring = Math.floor(Math.sqrt(attempt));
        const offset = attempt - ring * ring;
        const candidate = {
          x: Math.round(baseX + xSign * ring * dx),
          y: Math.round(baseY + ySign * offset * dy),
          width: Number(width),
          height: Number(height)
        };
        if (!paddedBounds.some(({ bounds }) => rectsOverlap(candidate, bounds))) {
          region = candidate;
          break;
        }
      }
      region ||= {
        x: Math.round(baseX + xSign * (Number(maxAttempts) + 1) * dx),
        y: Math.round(baseY),
        width: Number(width),
        height: Number(height)
      };
      const center = { x: region.x + region.width / 2, y: region.y + region.height / 2 };
      const nearestNodes = currentNodes
        .map((node) => {
          const b = nodeBounds(node, 0);
          const nodeCenter = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
          return {
            id: node.id,
            type: node.type,
            title: getNodeTitle(node),
            position: node.position,
            distance: Math.round(Math.hypot(center.x - nodeCenter.x, center.y - nodeCenter.y))
          };
        })
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 8);
      return {
        ok: true,
        canvasId,
        region,
        anchor: anchor ? compactNodeSummary(anchor, { includeTextPreview: true, textPreviewLength: 80 }) : null,
        nearestNodes,
        counts: { nodes: currentNodes.length, edges: currentEdges.length, textMatches: textMatches.length },
        warnings: region ? [] : ["No fully empty region found within maxAttempts; returned fallback region."]
      };
    });

  const inspectNodeTemplate = async ({ nodeId, id, includePosition = false } = {}) => {
    const targetId = nodeId || id;
    if (!targetId) throw new Error("nodeId is required");
    return withCanvasYjs(({ nodes, canvasId }) => {
      const node = yArrayToJson(nodes).find((item) => item?.id === targetId);
      if (!node) throw new Error(`Node not found: ${targetId}`);

      const template = safeJson(node);
      delete template.id;
      delete template.selected;
      delete template.dragging;
      if (!includePosition) {
        delete template.position;
        delete template.positionAbsolute;
        delete template.computedPosition;
        delete template.zIndex;
      }

      const suggestedCreateConfig = {
        type: node.type,
        node: template,
        data: template.data || {}
      };
      if (includePosition && node.position) suggestedCreateConfig.position = node.position;

      return {
        canvasId,
        sourceNodeId: targetId,
        type: node.type,
        dataKeys: Object.keys(node.data || {}).sort(),
        template,
        suggestedCreateConfig
      };
    });
  };

  const inspectModelOptions = ({ nodeType, subType } = {}) => {
    const entries = Object.entries(MODEL_OPTIONS).filter(([, value]) => {
      if (subType && value !== MODEL_OPTIONS[subType]) return false;
      if (nodeType && value.nodeType !== nodeType) return false;
      return true;
    });
    return {
      source: "observed-from-current-RunningHub-ui",
      aliases: MODEL_ALIASES,
      options: Object.fromEntries(entries.length ? entries : Object.entries(MODEL_OPTIONS))
    };
  };

  const getConnections = async ({ nodeId, nodeIds = [], direction = "both", depth = 1 } = {}) => {
    const seeds = [...nodeIds, nodeId].filter(Boolean);
    if (!seeds.length) throw new Error("nodeId or nodeIds is required");
    const maxDepth = Math.max(1, Number(depth) || 1);
    return withCanvasYjs(({ nodes, edges, canvasId }) => {
      const currentNodes = yArrayToJson(nodes);
      const currentEdges = yArrayToJson(edges);
      const nodeById = new Map(currentNodes.map((node) => [node?.id, node]).filter(([id]) => id));
      const seenNodes = new Set(seeds);
      const seenEdges = new Set();
      let frontier = seeds;

      for (let level = 0; level < maxDepth; level++) {
        const next = [];
        for (const edge of currentEdges) {
          const downstream = (direction === "both" || direction === "downstream") && frontier.includes(edge?.source);
          const upstream = (direction === "both" || direction === "upstream") && frontier.includes(edge?.target);
          if (!downstream && !upstream) continue;
          if (edge?.id) seenEdges.add(edge.id);
          const connectedId = downstream ? edge?.target : edge?.source;
          if (connectedId && !seenNodes.has(connectedId)) {
            seenNodes.add(connectedId);
            next.push(connectedId);
          }
        }
        frontier = next;
        if (!frontier.length) break;
      }

      return {
        canvasId,
        seeds,
        direction,
        depth: maxDepth,
        nodes: [...seenNodes].map((id) => nodeById.get(id) || { id, missing: true }),
        edges: currentEdges.filter((edge) => seenEdges.has(edge?.id)),
        counts: { nodes: seenNodes.size, edges: seenEdges.size }
      };
    });
  };

  const collectUpstreamSubgraph = ({ targetId, nodes, edges, maxDepth = 8 }) => {
    const nodeById = new Map(nodes.map((node) => [node?.id, node]).filter(([id]) => id));
    const includedNodeIds = new Set([targetId]);
    const includedEdgeIds = new Set();
    let frontier = [targetId];

    for (let level = 0; level < maxDepth; level++) {
      const next = [];
      for (const edge of edges) {
        if (!frontier.includes(edge?.target)) continue;
        if (edge?.id) includedEdgeIds.add(edge.id);
        if (edge?.source && !includedNodeIds.has(edge.source)) {
          includedNodeIds.add(edge.source);
          next.push(edge.source);
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }

    const orderedNodes = [targetId, ...[...includedNodeIds].filter((id) => id !== targetId)]
      .map((id) => nodeById.get(id))
      .filter(Boolean);
    const includedEdges = edges.filter((edge) => includedEdgeIds.has(edge?.id));
    return { nodes: orderedNodes, edges: includedEdges };
  };

  const firstPresentString = (...values) => values.find((value) => typeof value === "string" && value.trim())?.trim() || "";

  const imageUrlsFromNode = (node) => {
    const data = node?.data || {};
    const urls = [];
    for (const item of data.output || []) {
      if (item?.success === false) continue;
      if (item?.mediaCategory && item.mediaCategory !== "image") continue;
      if (item?.url) urls.push(item.url);
    }
    for (const url of data.sourceObjects || []) {
      if (typeof url === "string") urls.push(url);
    }
    for (const url of data.params?.imageUrls || []) {
      if (typeof url === "string") urls.push(url);
    }
    return [...new Set(urls.filter(Boolean))];
  };

  const textFromNode = (node) => firstPresentString(node?.data?.text, node?.data?.params?.prompt);

  const outputUrlsFromNode = (node) =>
    (node?.data?.output || [])
      .filter((item) => item?.success !== false && item?.url)
      .map((item) => ({
        url: item.url,
        mediaCategory: item.mediaCategory,
        outputType: item.outputType,
        name: item.name,
        taskId: item.taskId,
        jobId: item.jobId
      }));

  const terminalNodeStatuses = new Set(["finished", "failed", "error", "cancelled", "canceled"]);

  const summarizeNodeResult = (node) => ({
    nodeId: node?.id,
    type: node?.type,
    title: node?.data?.title,
    status: node?.data?.status,
    taskId: node?.data?.taskId,
    outputCount: Array.isArray(node?.data?.output) ? node.data.output.length : 0,
    outputs: outputUrlsFromNode(node),
    sourceUrls: imageUrlsFromNode(node),
    hasTerminalStatus: terminalNodeStatuses.has(String(node?.data?.status || "").toLowerCase())
  });

  const directUpstreamNodes = ({ targetId, nodes, edges }) => {
    const nodeById = new Map(nodes.map((node) => [node?.id, node]).filter(([id]) => id));
    return edges
      .filter((edge) => edge?.target === targetId)
      .map((edge) => ({ edge, node: nodeById.get(edge?.source) }))
      .filter((item) => item.node);
  };

  const videoRunValidation = ({ targetId, nodes, edges, requireReferences = true } = {}) => {
    const target = nodes.find((node) => node?.id === targetId);
    const errors = [];
    if (!target) {
      return { ok: false, errors: [`Node not found: ${targetId}`], targetId };
    }
    if (target.type !== "rh-video") errors.push(`Expected rh-video node, got ${target.type || "unknown"}`);

    const params = target.data?.params || {};
    const imageUrls = Array.isArray(params.imageUrls) ? params.imageUrls.filter(Boolean) : [];
    const upstream = directUpstreamNodes({ targetId, nodes, edges });
    const upstreamImages = upstream
      .filter(({ node }) => node?.type === "rh-image")
      .map(({ node, edge }) => ({ nodeId: node.id, edgeId: edge.id, urls: imageUrlsFromNode(node) }));
    const upstreamImageUrls = new Set(upstreamImages.flatMap((item) => item.urls));
    const missingUpstreamUrls = imageUrls.filter((url) => !upstreamImageUrls.has(url));
    const prompt = firstPresentString(params.prompt);

    if (!prompt) errors.push("Video prompt is empty");
    if (requireReferences) {
      if (target.data?.subType !== "multimodal-video") errors.push(`Expected subType multimodal-video, got ${target.data?.subType || "empty"}`);
      if (!String(target.data?.modelCode || "").includes("multimodal-video")) {
        errors.push(`Expected multimodal video modelCode, got ${target.data?.modelCode || "empty"}`);
      }
      if (!imageUrls.length) errors.push("params.imageUrls is empty");
      if (!upstreamImages.length) errors.push("No direct upstream rh-image edges");
      if (missingUpstreamUrls.length) errors.push(`imageUrls without matching direct upstream image output: ${missingUpstreamUrls.join(", ")}`);
      if (!Array.isArray(params.conversionSlots) || !params.conversionSlots.length) errors.push("params.conversionSlots is empty");
    }

    return {
      ok: errors.length === 0,
      errors,
      targetId,
      modelCode: target.data?.modelCode,
      subType: target.data?.subType,
      promptChars: prompt.length,
      references: imageUrls.map((url) => ({ url, hasDirectUpstreamImage: upstreamImageUrls.has(url) })),
      upstreamImages,
      upstreamTextNodes: upstream
        .filter(({ node }) => node?.type === "rh-text")
        .map(({ node, edge }) => ({ nodeId: node.id, edgeId: edge.id, chars: textFromNode(node).length }))
    };
  };

  const validateNodeRunSnapshot = ({ targetId, nodes, edges, requireReferences = false } = {}) => {
    const target = nodes.find((node) => node?.id === targetId);
    const errors = [];
    const warnings = [];
    if (!target) {
      return { ok: false, errorCode: "NODE_NOT_FOUND", errors: [`Node not found: ${targetId}`], warnings, targetId };
    }

    const params = target.data?.params || {};
    const prompt = firstPresentString(target.data?.text, params.prompt);
    const upstream = directUpstreamNodes({ targetId, nodes, edges });
    const upstreamImages = upstream.filter(({ node }) => node?.type === "rh-image").map(({ node, edge }) => ({ nodeId: node.id, edgeId: edge.id, urls: imageUrlsFromNode(node) }));
    const upstreamTexts = upstream.filter(({ node }) => node?.type === "rh-text").map(({ node, edge }) => ({ nodeId: node.id, edgeId: edge.id, chars: textFromNode(node).length }));
    const imageUrls = Array.isArray(params.imageUrls) ? params.imageUrls.filter(Boolean) : [];

    if (!target.type) errors.push("Node type is empty");
    if (!target.data?.modelCode && target.type !== "group") warnings.push("modelCode is empty");
    if ((target.type === "rh-text" || target.type === "rh-image" || target.type === "rh-video") && !prompt && !upstreamTexts.length) {
      warnings.push("No direct prompt text found");
    }
    if (target.type === "rh-image" && target.data?.subType === "image-image" && requireReferences && !upstreamImages.length && !imageUrls.length) {
      errors.push("Image-to-image node has no image references");
    }
    if (target.type === "rh-video" && String(target.data?.subType || "").includes("video")) {
      const videoValidation = videoRunValidation({ targetId, nodes, edges, requireReferences });
      errors.push(...videoValidation.errors);
    }

    return {
      ok: errors.length === 0,
      errorCode: errors.length ? "VALIDATION_FAILED" : null,
      errors,
      warnings,
      targetId,
      type: target.type,
      subType: target.data?.subType,
      modelCode: target.data?.modelCode,
      promptChars: prompt.length,
      upstreamImages,
      upstreamTexts,
      imageUrls,
      wouldSpendCredits: ["rh-text", "rh-image", "rh-video"].includes(target.type),
      nextActions: errors.length ? ["Fix validation errors before run-node or generate-video-node."] : []
    };
  };

  const validateNodeRun = async ({ nodeId, id, targetId, requireReferences = false } = {}) => {
    const target = targetId || nodeId || id;
    if (!target) throw new Error("nodeId is required");
    return withCanvasYjs(({ nodes, edges }) =>
      validateNodeRunSnapshot({
        targetId: target,
        nodes: yArrayToJson(nodes),
        edges: yArrayToJson(edges),
        requireReferences
      })
    );
  };

  const uniquePromptParts = (parts) => {
    const seen = new Set();
    return parts
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .filter((part) => {
        if (seen.has(part)) return false;
        seen.add(part);
        return true;
      });
  };

  const prepareVideoNode = async ({ nodeId, id, targetId, prompt, appendPrompt = "", promptMergeMode = "merge", referenceNodeIds, maxDepth = 1, modelCode, dryRun, ...command } = {}) => {
    const target = targetId || nodeId || id;
    if (!target) throw new Error("nodeId is required");
    return withCanvasMutation({ type: "canvas.prepareVideoNode", dryRun, ...command }, ({ Y, doc, nodes, edges }) => {
      const currentNodes = yArrayToJson(nodes);
      const currentEdges = yArrayToJson(edges);
      const nodeById = new Map(currentNodes.map((node) => [node?.id, node]).filter(([id]) => id));
      const videoNode = nodeById.get(target);
      if (!videoNode) throw new Error(`Node not found: ${target}`);
      if (videoNode.type !== "rh-video") throw new Error(`Expected rh-video node, got ${videoNode.type || "unknown"}`);

      const upstream = collectUpstreamSubgraph({ targetId: target, nodes: currentNodes, edges: currentEdges, maxDepth: Number(maxDepth) || 1 });
      const direct = directUpstreamNodes({ targetId: target, nodes: currentNodes, edges: currentEdges });
      const textNodes = upstream.nodes.filter((node) => node?.id !== target && node?.type === "rh-text");
      const existingPrompt = videoNode.data?.params?.prompt || "";
      const upstreamPrompt = textNodes.map(textFromNode).filter(Boolean).join("\n\n");
      const incomingPrompt = prompt !== undefined ? prompt : upstreamPrompt;
      const finalPrompt =
        promptMergeMode === "replace"
          ? uniquePromptParts([incomingPrompt || existingPrompt, appendPrompt]).join("\n\n")
          : promptMergeMode === "append"
            ? uniquePromptParts([existingPrompt, appendPrompt || incomingPrompt]).join("\n\n")
            : uniquePromptParts([existingPrompt, incomingPrompt, appendPrompt]).join("\n\n");

      const requestedReferenceNodes = Array.isArray(referenceNodeIds)
        ? referenceNodeIds.map((refId) => nodeById.get(refId)).filter(Boolean)
        : direct.filter(({ node }) => node?.type === "rh-image").map(({ node }) => node);
      const referenceEntries = requestedReferenceNodes
        .map((node) => ({ node, url: imageUrlsFromNode(node)[0] }))
        .filter((item) => item.url);
      const imageUrls = [...new Set(referenceEntries.map((item) => item.url))];
      if (!imageUrls.length) throw new Error("No upstream image outputs found for video references");
      const existingModelCode = videoNode.data?.modelCode || "";
      const nextModelCode = modelCode || (String(existingModelCode).includes("multimodal-video") ? existingModelCode : MODEL_OPTIONS["multimodal-video"].defaultModelCode);

      const next = {
        ...videoNode,
        data: {
          ...(videoNode.data || {}),
          params: {
            ...(videoNode.data?.params || {}),
            prompt: finalPrompt,
            resolution: videoNode.data?.params?.resolution || "720p",
            duration: String(videoNode.data?.params?.duration || "5"),
            imageUrls,
            videoUrls: videoNode.data?.params?.videoUrls || [],
            audioUrls: videoNode.data?.params?.audioUrls || [],
            generateAudio: videoNode.data?.params?.generateAudio ?? true,
            ratio: videoNode.data?.params?.ratio ?? null,
            realPersonMode: videoNode.data?.params?.realPersonMode ?? false,
            conversionSlots:
              Array.isArray(videoNode.data?.params?.conversionSlots) && videoNode.data.params.conversionSlots.length
                ? videoNode.data.params.conversionSlots
                : ["all"]
          },
          modelCode: nextModelCode,
          subType: "multimodal-video",
          hasUpstream: true,
          preparedBy: "bridge",
          preparedAt: Date.now()
        }
      };

      const addedEdges = [];
      doc.transact(() => {
        for (let index = 0; index < nodes.length; index++) {
          const item = nodes.get(index);
          const json = item?.toJSON?.() || item;
          if (json?.id !== target) continue;
          nodes.delete(index, 1);
          nodes.insert(index, [toYValue(Y, next)]);
          break;
        }
        const existingEdgeIds = new Set(yArrayToJson(edges).map((edge) => edge?.id));
        for (const { node } of referenceEntries) {
          const edgeId = `e-${node.id}-${target}`;
          if (existingEdgeIds.has(edgeId)) continue;
          const edge = { id: edgeId, source: node.id, target, sourceHandle: "output", targetHandle: "input", type: "default", animated: false };
          edges.push([toYValue(Y, edge)]);
          addedEdges.push(edge);
          existingEdgeIds.add(edgeId);
        }
      });

      const afterEdges = [...currentEdges, ...addedEdges];
      return {
        nodeId: target,
        node: next,
        addedEdges,
        validation: videoRunValidation({ targetId: target, nodes: currentNodes.map((node) => (node?.id === target ? next : node)), edges: afterEdges })
      };
    });
  };

  const validateVideoRun = async ({ nodeId, id, targetId, requireReferences = true } = {}) => {
    const target = targetId || nodeId || id;
    if (!target) throw new Error("nodeId is required");
    return withCanvasYjs(({ nodes, edges }) =>
      videoRunValidation({
        targetId: target,
        nodes: yArrayToJson(nodes),
        edges: yArrayToJson(edges),
        requireReferences
      })
    );
  };

  const generateVideoNode = async ({ nodeId, id, targetId, maxDepth = 2, runMaxDepth = 8, maxChars = 120000, dryRun = false, ...command } = {}) => {
    const target = targetId || nodeId || id;
    if (!target) throw new Error("nodeId is required");
    const prepared = await prepareVideoNode({ ...command, nodeId: target, maxDepth, dryRun });
    const preparedResult = prepared.result || prepared;
    const preparedValidation = preparedResult.validation;
    if (!preparedValidation?.ok) {
      throw new Error(`Video preparation validation failed: ${(preparedValidation?.errors || []).join("; ")}`);
    }
    if (dryRun) return { dryRun: true, prepared, validation: preparedValidation, run: null };
    const validation = await validateVideoRun({ nodeId: target, requireReferences: true });
    if (!validation.ok) throw new Error(`Video run validation failed: ${validation.errors.join("; ")}`);
    const run = await runNode({ nodeId: target, maxDepth: runMaxDepth, maxChars, validateReferences: true });
    return { prepared, validation, run };
  };

  const runNode = async ({ nodeId, id, targetId, maxDepth = 8, maxChars = 120000, validateReferences = false } = {}) => {
    const target = targetId || nodeId || id;
    if (!target) throw new Error("nodeId is required");
    const payload = await withCanvasYjs(({ nodes, edges, canvasId }) => {
      const currentNodes = yArrayToJson(nodes);
      const currentEdges = yArrayToJson(edges);
      const targetNode = currentNodes.find((node) => node?.id === target);
      if (!targetNode) throw new Error(`Node not found: ${target}`);
      if (validateReferences) {
        const validation = validateNodeRunSnapshot({ targetId: target, nodes: currentNodes, edges: currentEdges, requireReferences: true });
        if (!validation.ok) throw new Error(`Node run validation failed: ${validation.errors.join("; ")}`);
      }
      const subgraph = collectUpstreamSubgraph({ targetId: target, nodes: currentNodes, edges: currentEdges, maxDepth: Number(maxDepth) || 8 });
      return {
        canvasId,
        targetType: "NODE",
        targetId: target,
        canvas: subgraph
      };
    });
    const response = await postJson("/canvas/task/run", payload, maxChars);
    return { request: payload, response, task: taskInfoFromRunResponse(response) };
  };

  const mergePlainObject = (target, patch) => {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return target;
    return { ...(target || {}), ...patch };
  };

  const createTextWorkflow = async (config = {}, command = {}) =>
    withCanvasMutation(command, ({ Y, doc, nodes, edges, canvasId }) => {
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
        canvasId,
        added: { nodes: [sourceId, targetId, groupId], edges: [edgeId] },
        before: { nodes: currentNodes.length, edges: currentEdges.length },
        after: { nodes: currentNodes.length + 3, edges: currentEdges.length + 1 }
      };
    });

  const createTextNode = async (config = {}, command = {}) =>
    withCanvasMutation(command, ({ Y, doc, nodes }) => {
      const currentNodes = yArrayToJson(nodes);
      const timestamp = Date.now();
      const suffix = Math.random().toString(36).slice(2, 10);
      const nodeId = config.id || `node-${timestamp}-${suffix}`;
      const maxX = currentNodes.reduce((max, node) => Math.max(max, Number(node?.position?.x) || 0), 0);
      const node = {
        id: nodeId,
        type: "rh-text",
        position: {
          x: Number(config.x) || Math.max(300, maxX + 360),
          y: Number(config.y) || 300
        },
        zIndex: currentNodes.length + 1,
        style: {},
        selectable: true,
        data: {
          params: { prompt: "" },
          modelCode: "text-text-rhart-text-g-3-flash-preview",
          generateNum: 1,
          subType: "text-text",
          textModelListType: "text-text",
          title: config.title || "API 文本节点",
          agentCreated: true,
          from: "bridge",
          agentNodeType: config.agentNodeType || "copywriting",
          status: "idle",
          text: config.text || "API 写入：文本节点",
          maxConnect: { image: null, text: null, video: null }
        }
      };
      doc.transact(() => nodes.push([toYValue(Y, node)]));
      return { nodeId, node };
    });

  const createTextNodes = async (configs = [], command = {}) =>
    withCanvasMutation(command, ({ Y, doc, nodes, canvasId }) => {
      const items = Array.isArray(configs) ? configs : configs?.nodes || configs?.items || [];
      if (!items.length) throw new Error("config-json must be a non-empty array or object with nodes/items");
      const currentNodes = yArrayToJson(nodes);
      const timestamp = Date.now();
      const maxX = currentNodes.reduce((max, node) => Math.max(max, Number(node?.position?.x) || 0), 0);
      const baseX = Number(command.x ?? items[0]?.x ?? Math.max(300, maxX + 360));
      const baseY = Number(command.y ?? items[0]?.y ?? 300);
      const gapX = Number(command.gapX ?? 420);
      const gapY = Number(command.gapY ?? 260);
      const created = items.map((config, index) => {
        const suffix = Math.random().toString(36).slice(2, 10);
        const nodeId = config.id || `node-${timestamp}-${index}-${suffix}`;
        return {
          id: nodeId,
          type: "rh-text",
          position: {
            x: Number(config.x ?? baseX + (index % 3) * gapX),
            y: Number(config.y ?? baseY + Math.floor(index / 3) * gapY)
          },
          zIndex: currentNodes.length + index + 1,
          style: {},
          selectable: true,
          data: {
            params: { prompt: "" },
            modelCode: "text-text-rhart-text-g-3-flash-preview",
            generateNum: 1,
            subType: "text-text",
            textModelListType: "text-text",
            title: config.title || `Agent 文本节点 ${index + 1}`,
            agentCreated: true,
            from: "bridge",
            agentNodeType: config.agentNodeType || "copywriting",
            status: "idle",
            text: config.text || "",
            maxConnect: { image: null, text: null, video: null },
            ...(config.data || {})
          }
        };
      });
      doc.transact(() => nodes.push(created.map((node) => toYValue(Y, node))));
      return {
        ok: true,
        canvasId,
        operationId: command.id,
        nodeIds: created.map((node) => node.id),
        nodes: created.map((node) => compactNodeSummary(node, { includeTextPreview: true, textPreviewLength: 120 })),
        counts: { createdNodes: created.length }
      };
    });

  const groupElements = async ({ ids = [], nodeIds = [], title, groupName, padding = 80, style = {}, groupId, groupColor = "rgba(75, 130, 180, 0.18)", borderColor = "rgba(75, 130, 180, 0.65)", ...command } = {}) =>
    withCanvasMutation({ type: "canvas.groupElements", ...command }, ({ Y, doc, nodes }) => {
      const targetIds = [...ids, ...nodeIds].filter(Boolean);
      if (!targetIds.length) throw new Error("At least one node id is required");
      const targetSet = new Set(targetIds);
      const currentNodes = yArrayToJson(nodes);
      const targets = currentNodes.filter((node) => targetSet.has(node?.id) && node?.type !== "group");
      const missing = targetIds.filter((id) => !targets.some((node) => node.id === id));
      if (missing.length) throw new Error(`Node not found or not groupable: ${missing.join(", ")}`);
      const pad = Number(padding) || 80;
      const bounds = targets.map((node) => nodeBounds(node, 0));
      const minX = Math.min(...bounds.map((item) => item.x));
      const minY = Math.min(...bounds.map((item) => item.y));
      const maxX = Math.max(...bounds.map((item) => item.x + item.width));
      const maxY = Math.max(...bounds.map((item) => item.y + item.height));
      const nextGroupId = groupId || `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const groupPosition = { x: minX - pad, y: minY - pad };
      const group = {
        id: nextGroupId,
        type: "group",
        position: groupPosition,
        zIndex: -1000,
        style,
        selectable: false,
        data: {
          title: "节点",
          groupName: groupName || title || "Agent 分组",
          groupColor,
          borderColor,
          nodeIds: targets.map((node) => node.id),
          width: maxX - minX + pad * 2,
          height: maxY - minY + pad * 2,
          nodeOffsets: Object.fromEntries(targets.map((node) => [node.id, { x: (Number(node.position?.x) || 0) - groupPosition.x, y: (Number(node.position?.y) || 0) - groupPosition.y }])),
          status: "idle"
        }
      };
      const groupedNodes = [];
      doc.transact(() => {
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes.get(index);
          const nodeJson = node?.toJSON?.() || node;
          if (!targetSet.has(nodeJson?.id) || nodeJson?.type === "group") continue;
          const next = {
            ...nodeJson,
            data: {
              ...(nodeJson.data || {}),
              groupId: nextGroupId,
              groupColor,
              addNewGroup: true
            }
          };
          nodes.delete(index, 1);
          nodes.insert(index, [toYValue(Y, next)]);
          groupedNodes.push(compactNodeSummary(next, { includeTextPreview: false }));
        }
        nodes.push([toYValue(Y, group)]);
      });
      return {
        ok: true,
        groupId: nextGroupId,
        groupedNodeIds: targets.map((node) => node.id),
        group,
        groupedNodes,
        counts: { groupedNodes: targets.length, addedGroups: 1 }
      };
    });

  const createNode = async (config = {}, command = {}) =>
    withCanvasMutation(command, ({ Y, doc, nodes }) => {
      const currentNodes = yArrayToJson(nodes);
      const timestamp = Date.now();
      const suffix = Math.random().toString(36).slice(2, 10);
      const template = config.node && typeof config.node === "object" ? config.node : {};
      const nodeId = config.id || template.id || `node-${timestamp}-${suffix}`;
      const maxX = currentNodes.reduce((max, node) => Math.max(max, Number(node?.position?.x) || 0), 0);
      const node = {
        ...template,
        id: nodeId,
        type: config.type || template.type || "rh-text",
        position: {
          x: Number(config.x ?? template.position?.x ?? Math.max(300, maxX + 360)),
          y: Number(config.y ?? template.position?.y ?? 300)
        },
        zIndex: Number(config.zIndex ?? template.zIndex ?? currentNodes.length + 1),
        style: template.style || config.style || {},
        selectable: config.selectable ?? template.selectable ?? true,
        data: {
          ...(template.data || {}),
          ...(config.data || {})
        }
      };
      if (config.position) node.position = { ...node.position, ...config.position };
      doc.transact(() => nodes.push([toYValue(Y, node)]));
      return { nodeId, node };
    });

  const createVideoNode = async (config = {}, command = {}) =>
    withCanvasMutation(command, ({ Y, doc, nodes, edges }) => {
      const targetSubType = config.subType || config.data?.subType || "text-video";
      const model = resolveModelAlias({ modelName: config.modelName, modelCode: config.modelCode, subType: targetSubType });
      const currentNodes = yArrayToJson(nodes);
      const timestamp = Date.now();
      const suffix = Math.random().toString(36).slice(2, 10);
      const nodeId = config.id || `node_${timestamp}_${suffix}`;
      const maxX = currentNodes.reduce((max, node) => Math.max(max, Number(node?.position?.x) || 0), 0);
      const node = {
        id: nodeId,
        type: "rh-video",
        position: {
          x: Number(config.x ?? Math.max(300, maxX + 360)),
          y: Number(config.y ?? 400)
        },
        zIndex: currentNodes.length + 1,
        style: {},
        selectable: true,
        data: {
          params: {
            prompt: config.prompt || "",
            resolution: config.resolution || "480p",
            duration: String(config.duration || "5"),
            generateAudio: config.generateAudio ?? true,
            ratio: config.ratio ?? null,
            webSearch: config.webSearch ?? false,
            ...(model?.params || {}),
            ...(config.params || {})
          },
          modelCode: model?.modelCode || config.modelCode || "text-video-sparkvideo-2.0",
          generateNum: Number(config.generateNum || 1),
          subType: targetSubType,
          title: config.title || "视频生成",
          type: "rh-video",
          status: "idle",
          ...(model
            ? {
                requestedModelName: model.requestedModelName,
                runningHubModelName: model.runningHubModelName,
                modelMappingStatus: model.mappingStatus
              }
            : {}),
          ...(config.sourceNodeId ? { inheritedFrom: config.sourceNodeId, hasUpstream: true } : {}),
          ...(config.data || {})
        }
      };
      const addedEdges = [];
      doc.transact(() => {
        nodes.push([toYValue(Y, node)]);
        if (config.sourceNodeId) {
          const edge = {
            id: config.edgeId || `e-${config.sourceNodeId}-${nodeId}`,
            source: config.sourceNodeId,
            target: nodeId,
            sourceHandle: config.sourceHandle || "output",
            targetHandle: config.targetHandle || "input",
            type: "default",
            animated: false
          };
          edges.push([toYValue(Y, edge)]);
          addedEdges.push(edge);
        }
      });
      return {
        nodeId,
        node,
        edges: addedEdges,
        nextActions: [
          "This command only creates/configures the video node; it does not run generation.",
          targetSubType === "multimodal-video"
            ? "Connect or provide reference image nodes, then run prepare-video-node and validate-video-run before paid generation."
            : "For image-conditioned video, connect reference image nodes and run prepare-video-node to switch the node to multimodal-video."
        ]
      };
    });

  const createImageNode = async (config = {}, command = {}) =>
    withCanvasMutation(command, ({ Y, doc, nodes, edges }) => {
      const model = resolveModelAlias({ modelName: config.modelName, modelCode: config.modelCode, subType: config.subType || "text-image" });
      const currentNodes = yArrayToJson(nodes);
      const timestamp = Date.now();
      const suffix = Math.random().toString(36).slice(2, 10);
      const nodeId = config.id || `node-${timestamp}-${suffix}`;
      const maxX = currentNodes.reduce((max, node) => Math.max(max, Number(node?.position?.x) || 0), 0);
      const node = {
        id: nodeId,
        type: "rh-image",
        position: {
          x: Number(config.x ?? Math.max(300, maxX + 360)),
          y: Number(config.y ?? 400)
        },
        zIndex: currentNodes.length + 1,
        style: {},
        selectable: true,
        data: {
          params: {
            prompt: config.prompt || "",
            aspectRatio: config.aspectRatio ?? null,
            quality: config.quality || "medium",
            resolution: config.resolution || "1k",
            ...(model?.params || {}),
            ...(config.params || {})
          },
          modelCode: model?.modelCode || MODEL_OPTIONS["text-image"].defaultModelCode,
          generateNum: Number(config.generateNum || 1),
          subType: config.subType || "text-image",
          title: config.title || "图片上传",
          status: "idle",
          panorama: {
            pausedModel: ""
          },
          ...(model
            ? {
                requestedModelName: model.requestedModelName,
                runningHubModelName: model.runningHubModelName,
                modelMappingStatus: model.mappingStatus
              }
            : {}),
          ...(config.sourceNodeId ? { inheritedFrom: config.sourceNodeId, hasUpstream: true } : {}),
          ...(config.data || {})
        }
      };
      const addedEdges = [];
      doc.transact(() => {
        nodes.push([toYValue(Y, node)]);
        if (config.sourceNodeId) {
          const edge = {
            id: config.edgeId || `e-${config.sourceNodeId}-${nodeId}`,
            source: config.sourceNodeId,
            target: nodeId,
            sourceHandle: config.sourceHandle || "output",
            targetHandle: config.targetHandle || "input",
            type: "default",
            animated: false
          };
          edges.push([toYValue(Y, edge)]);
          addedEdges.push(edge);
        }
      });
      return {
        nodeId,
        node,
        edges: addedEdges,
        nextActions: [
          "This command only creates/configures the image node; it does not generate an image.",
          "Run validate-node-run, then run-node when paid image generation is intended."
        ]
      };
    });

  const createReferenceImageNode = async (config = {}, command = {}) =>
    withCanvasMutation(command, ({ Y, doc, nodes, edges }) => {
      const sourceUrl = config.sourceUrl || config.url || config.sourceObject;
      if (!sourceUrl) throw new Error("sourceUrl is required");
      const currentNodes = yArrayToJson(nodes);
      const timestamp = Date.now();
      const suffix = Math.random().toString(36).slice(2, 10);
      const nodeId = config.id || `node_${timestamp}_${suffix}`;
      const maxX = currentNodes.reduce((max, node) => Math.max(max, Number(node?.position?.x) || 0), 0);
      const node = {
        id: nodeId,
        type: "rh-image",
        position: {
          x: Number(config.x ?? Math.max(300, maxX + 360)),
          y: Number(config.y ?? 400)
        },
        zIndex: currentNodes.length + 1,
        style: {},
        selectable: true,
        data: {
          params: {
            prompt: "",
            aspectRatio: null,
            quality: "medium",
            resolution: "1k",
            ...(config.params || {})
          },
          modelCode: config.modelCode || MODEL_OPTIONS["text-image"].defaultModelCode,
          generateNum: Number(config.generateNum || 1),
          subType: config.subType || "text-image",
          title: config.title || "参考图",
          sourceObjects: [sourceUrl],
          status: "idle",
          panorama: {
            pausedModel: ""
          },
          width: Number(config.width || 380),
          height: Number(config.height || 320),
          label: config.label || config.name || "reference image",
          ...(config.data || {})
        }
      };
      const addedEdges = [];
      doc.transact(() => {
        nodes.push([toYValue(Y, node)]);
        if (config.targetNodeId) {
          const edge = {
            id: config.edgeId || `edge_${nodeId}_${config.targetNodeId}`,
            source: nodeId,
            target: config.targetNodeId,
            sourceHandle: config.sourceHandle || "output",
            targetHandle: config.targetHandle || "input",
            type: "default",
            animated: false
          };
          edges.push([toYValue(Y, edge)]);
          addedEdges.push(edge);
        }
      });
      return { nodeId, node, edges: addedEdges };
    });

  const createReferenceFromUrl = async ({ url, sourceUrl, targetNodeId, config = {}, dryRun, ...command } = {}) => {
    const referenceUrl = sourceUrl || url;
    if (!referenceUrl) throw new Error("url is required");
    const created = await createReferenceImageNode(
      {
        ...config,
        sourceUrl: referenceUrl,
        targetNodeId: targetNodeId || config.targetNodeId
      },
      { type: "canvas.createReferenceFromUrl", dryRun, ...command }
    );
    const result = created?.result || created;
    return {
      ok: true,
      dryRun: Boolean(created?.dryRun),
      applied: created?.applied,
      rollbackId: created?.rollbackId,
      primaryReference: {
        nodeId: result.nodeId,
        urls: [referenceUrl],
        title: result.node?.data?.title,
        label: result.node?.data?.label
      },
      usableReferences: [
        {
          nodeId: result.nodeId,
          urls: [referenceUrl],
          title: result.node?.data?.title,
          label: result.node?.data?.label
        }
      ],
      created,
      nextActions: targetNodeId ? [] : ["Connect primaryReference.nodeId to the target generation node when needed."]
    };
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const uploadReferenceImage = async ({ nodeId, targetNodeId, file = {}, inputIndex = 1, waitMs = 8000 } = {}) => {
    const target = targetNodeId || nodeId;
    if (!target) throw new Error("nodeId is required");
    if (!file.base64) throw new Error("file.base64 is required");
    const nodeEl = Array.from(document.querySelectorAll(".vue-flow__node")).find((el) => el.getAttribute("data-id") === target);
    if (!nodeEl) throw new Error(`Rendered node not found: ${target}`);
    nodeEl.click();
    await wait(500);

    const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
    const uploadFile = new File([bytes], file.name || "reference.jpg", {
      type: file.type || "image/jpeg",
      lastModified: Date.now()
    });
    const inputs = Array.from(document.querySelectorAll('.vue-flow__node-rh-image.selected input[type="file"][accept="image/*"]'));
    const orderedIndexes = [Number(inputIndex), 0, 1, 2].filter((value, index, array) => Number.isInteger(value) && value >= 0 && array.indexOf(value) === index);
    const attempts = [];
    for (const index of orderedIndexes) {
      const input = inputs[index];
      if (!input) continue;
      try {
        const transfer = new DataTransfer();
        transfer.items.add(uploadFile);
        Object.defineProperty(input, "files", { configurable: true, value: transfer.files });
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        attempts.push({ index, ok: true, multiple: input.multiple, files: input.files?.length || 0 });
        break;
      } catch (error) {
        attempts.push({ index, ok: false, error: String(error) });
      }
    }
    if (!attempts.some((attempt) => attempt.ok)) {
      throw new Error(`No image input accepted file: ${JSON.stringify(attempts)}`);
    }
    await wait(Number(waitMs) || 8000);
    const connections = await getConnections({ nodeId: target, direction: "upstream", depth: 1 });
    return { targetNodeId: target, file: { name: uploadFile.name, type: uploadFile.type, size: uploadFile.size }, attempts, connections };
  };

  const usableReferencesFromConnections = (connections = {}) => {
    const targetIds = new Set(connections.seeds || []);
    return (connections.nodes || [])
      .filter((node) => node?.type === "rh-image" && !targetIds.has(node.id))
      .map((node) => ({
        nodeId: node.id,
        title: node.data?.title,
        label: node.data?.label,
        urls: imageUrlsFromNode(node)
      }))
      .filter((item) => item.urls.length);
  };

  const uploadLocalReferenceImage = async ({ config = {}, file = {}, inputIndex = 1, waitMs = 8000, renderWaitMs = 1200, connectToNodeId } = {}) => {
    if (!file.base64) throw new Error("file.base64 is required");
    const stagingConfig = {
      title: file.name ? `参考图｜${file.name}` : "参考图",
      data: {
        label: file.name || "reference image",
        width: Number(config.width || 380),
        height: Number(config.height || 320)
      },
      ...config
    };
    const created = await createImageNode(stagingConfig, { type: "canvas.createImageNode" });
    const stagingNodeId = created?.result?.nodeId;
    if (!stagingNodeId) throw new Error("Failed to create staging image node");
    await wait(Number(renderWaitMs) || 1200);
    const uploaded = await uploadReferenceImage({ nodeId: stagingNodeId, file, inputIndex, waitMs });
    const usableReferences = usableReferencesFromConnections(uploaded.connections);
    const connectedEdges = [];
    if (connectToNodeId) {
      for (const reference of usableReferences) {
        const edgeResult = await connectNodes({ source: reference.nodeId, target: connectToNodeId });
        connectedEdges.push(edgeResult?.result || edgeResult);
      }
    }
    const ok = usableReferences.length > 0;
    return {
      ok,
      errorCode: ok ? null : "NO_USABLE_REFERENCE",
      stagingNodeId,
      file: uploaded.file,
      attempts: uploaded.attempts,
      usableReferences,
      primaryReference: usableReferences[0] || null,
      connectedEdges,
      connections: uploaded.connections,
      warnings: ok
        ? []
        : [
            "File injection succeeded, but no usable uploaded reference URL was found.",
            "Increase --wait-ms, verify the rendered upload node completed upload, or use create-reference-from-url with an existing image URL."
          ],
      nextActions: ok
        ? []
        : [
            "Retry with a longer --wait-ms.",
            "Check the RunningHub page for an upload error on the staging image node.",
            "Use create-reference-from-url if the image is already hosted."
          ]
    };
  };

  const pollNodeResult = async ({ nodeId, id, timeoutMs = 180000, intervalMs = 3000, requireOutput = true } = {}) => {
    const target = nodeId || id;
    if (!target) throw new Error("nodeId is required");
    const startedAt = Date.now();
    let lastSummary = null;
    while (Date.now() - startedAt <= Number(timeoutMs || 180000)) {
      const summary = await withCanvasYjs(({ nodes }) => {
        const node = yArrayToJson(nodes).find((item) => item?.id === target);
        if (!node) throw new Error(`Node not found: ${target}`);
        return summarizeNodeResult(node);
      });
      lastSummary = summary;
      const hasOutput = summary.outputCount > 0 || summary.outputs.length > 0;
      if ((requireOutput && hasOutput) || (!requireOutput && (hasOutput || summary.hasTerminalStatus))) {
        return { ok: true, done: true, elapsedMs: Date.now() - startedAt, ...summary };
      }
      if (summary.hasTerminalStatus && !hasOutput) {
        return { ok: false, done: true, elapsedMs: Date.now() - startedAt, ...summary };
      }
      await wait(Number(intervalMs || 3000));
    }
    return { ok: false, done: false, elapsedMs: Date.now() - startedAt, last: lastSummary };
  };

  const findTaskResultInSnapshot = ({ taskId, nodes }) => {
    for (const node of nodes) {
      const outputs = outputUrlsFromNode(node).filter((item) => item.taskId === taskId);
      if (outputs.length || node?.data?.taskId === taskId) {
        return {
          nodeId: node.id,
          type: node.type,
          title: node.data?.title,
          status: node.data?.status,
          taskId,
          outputs,
          outputCount: outputs.length,
          nodeSummary: summarizeNodeResult(node)
        };
      }
    }
    return null;
  };

  const pollTaskResult = async ({ taskId, timeoutMs = 180000, intervalMs = 3000, requireOutput = true } = {}) => {
    if (!taskId) throw new Error("taskId is required");
    const startedAt = Date.now();
    let last = null;
    while (Date.now() - startedAt <= Number(timeoutMs || 180000)) {
      const match = await withCanvasYjs(({ nodes }) => findTaskResultInSnapshot({ taskId, nodes: yArrayToJson(nodes) }));
      last = match;
      if (match && (!requireOutput || match.outputs.length)) {
        return { ok: true, done: true, elapsedMs: Date.now() - startedAt, ...match };
      }
      await wait(Number(intervalMs || 3000));
    }
    return { ok: false, done: false, elapsedMs: Date.now() - startedAt, taskId, last };
  };

  const updateNodeModel = async ({ nodeId, id, modelCode, modelName, data = {}, ...command } = {}) => {
    const targetId = nodeId || id;
    if (!targetId) throw new Error("nodeId is required");
    const model = resolveModelAlias({ modelName, modelCode, subType: data.subType });
    if (!model?.modelCode) throw new Error("modelCode or known modelName is required");
    return withCanvasMutation({ type: "canvas.updateNodeModel", ...command }, ({ Y, doc, nodes }) => {
      let updatedNode;
      doc.transact(() => {
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes.get(index);
          const nodeJson = node?.toJSON?.() || node;
          if (nodeJson?.id !== targetId) continue;
          const next = {
            ...nodeJson,
            data: {
              ...(nodeJson.data || {}),
              ...data,
              modelCode: model.modelCode,
              requestedModelName: model.requestedModelName,
              runningHubModelName: model.runningHubModelName,
              modelMappingStatus: model.mappingStatus,
              params: {
                ...(nodeJson.data?.params || {}),
                ...(data.params || {}),
                ...(model.params || {})
              }
            }
          };
          nodes.delete(index, 1);
          nodes.insert(index, [toYValue(Y, next)]);
          updatedNode = next;
          break;
        }
      });
      if (!updatedNode) throw new Error(`Node not found: ${targetId}`);
      return { updated: true, nodeId: targetId, node: updatedNode };
    });
  };

  const updateNodeParams = async ({ nodeId, id, params = {}, ...command } = {}) => {
    const targetId = nodeId || id;
    if (!targetId) throw new Error("nodeId is required");
    return withCanvasMutation({ type: "canvas.updateNodeParams", ...command }, ({ Y, doc, nodes }) => {
      let updatedNode;
      doc.transact(() => {
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes.get(index);
          const nodeJson = node?.toJSON?.() || node;
          if (nodeJson?.id !== targetId) continue;
          const next = {
            ...nodeJson,
            data: {
              ...(nodeJson.data || {}),
              params: {
                ...(nodeJson.data?.params || {}),
                ...params
              }
            }
          };
          nodes.delete(index, 1);
          nodes.insert(index, [toYValue(Y, next)]);
          updatedNode = next;
          break;
        }
      });
      if (!updatedNode) throw new Error(`Node not found: ${targetId}`);
      return { updated: true, nodeId: targetId, node: updatedNode };
    });
  };

  const connectNodes = async ({ source, target, sourceHandle = "output", targetHandle = "input", edgeId: requestedEdgeId, id: commandId, ...command } = {}) => {
    if (!source) throw new Error("source is required");
    if (!target) throw new Error("target is required");
    return withCanvasMutation({ type: "canvas.connectNodes", id: commandId, ...command }, ({ Y, doc, nodes, edges }) => {
      const nodeIds = new Set(yArrayToJson(nodes).map((node) => node?.id).filter(Boolean));
      if (!nodeIds.has(source)) throw new Error(`Source node not found: ${source}`);
      if (!nodeIds.has(target)) throw new Error(`Target node not found: ${target}`);
      const edgeId = requestedEdgeId || `e-${source}-${target}`;
      const existing = yArrayToJson(edges).some((edge) => edge?.id === edgeId);
      if (existing) return { edgeId, created: false };
      const edge = { id: edgeId, source, target, sourceHandle, targetHandle, type: "default", animated: false };
      doc.transact(() => edges.push([toYValue(Y, edge)]));
      return { edgeId, created: true, edge };
    });
  };

  const updateNodePosition = async ({ nodeId, x, y, ...command } = {}) => {
    if (!nodeId) throw new Error("nodeId is required");
    return withCanvasMutation({ type: "canvas.updateNodePosition", ...command }, ({ Y, doc, nodes }) => {
      let updated = false;
      doc.transact(() => {
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes.get(index);
          const nodeJson = node?.toJSON?.() || node;
          if (nodeJson?.id !== nodeId) continue;

          if (node instanceof Y.Map) {
            let position = node.get("position");
            if (!(position instanceof Y.Map)) {
              position = toYValue(Y, position || {});
              node.set("position", position);
            }
            if (x !== undefined) position.set("x", Number(x));
            if (y !== undefined) position.set("y", Number(y));
          } else {
            nodeJson.position ||= {};
            if (x !== undefined) nodeJson.position.x = Number(x);
            if (y !== undefined) nodeJson.position.y = Number(y);
            nodes.delete(index, 1);
            nodes.insert(index, [toYValue(Y, nodeJson)]);
          }
          updated = true;
          break;
        }
      });
      if (!updated) throw new Error(`Node not found: ${nodeId}`);
      return { updated: true, nodeId, x: x === undefined ? undefined : Number(x), y: y === undefined ? undefined : Number(y) };
    });
  };

  const updateNodeText = async ({ nodeId, text, title, ...command } = {}) => {
    if (!nodeId) throw new Error("nodeId is required");
    return withCanvasMutation({ type: "canvas.updateNodeText", ...command }, ({ Y, doc, nodes }) => {
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

  const updateNode = async ({ nodeId, id, patch = {}, position, data, style, title, text, zIndex, width, height, ...command } = {}) => {
    const targetId = nodeId || id;
    if (!targetId) throw new Error("nodeId is required");
    return withCanvasMutation({ type: "canvas.updateNode", ...command }, ({ Y, doc, nodes }) => {
      let updatedNode;
      doc.transact(() => {
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes.get(index);
          const nodeJson = node?.toJSON?.() || node;
          if (nodeJson?.id !== targetId) continue;

          const next = {
            ...nodeJson,
            ...patch,
            data: mergePlainObject(nodeJson.data, patch.data),
            style: mergePlainObject(nodeJson.style, patch.style),
            position: mergePlainObject(nodeJson.position, patch.position)
          };
          if (position) next.position = mergePlainObject(next.position, position);
          if (data) next.data = mergePlainObject(next.data, data);
          if (style) next.style = mergePlainObject(next.style, style);
          if (title !== undefined || text !== undefined) {
            next.data ||= {};
            if (title !== undefined) next.data.title = title;
            if (text !== undefined) next.data.text = text;
          }
          if (zIndex !== undefined) next.zIndex = Number(zIndex);
          if (width !== undefined) next.width = Number(width);
          if (height !== undefined) next.height = Number(height);

          nodes.delete(index, 1);
          nodes.insert(index, [toYValue(Y, next)]);
          updatedNode = next;
          break;
        }
      });
      if (!updatedNode) throw new Error(`Node not found: ${targetId}`);
      return { updated: true, nodeId: targetId, node: updatedNode };
    });
  };

  const moveNodes = async ({ nodeIds = [], ids = [], dx = 0, dy = 0, positions = {}, ...command } = {}) => {
    const targetIds = [...nodeIds, ...ids].filter(Boolean);
    if (!targetIds.length) throw new Error("nodeIds or ids is required");
    const targetSet = new Set(targetIds);
    const deltaX = Number(dx) || 0;
    const deltaY = Number(dy) || 0;
    return withCanvasMutation({ type: "canvas.moveNodes", ...command }, ({ Y, doc, nodes }) => {
      const moved = [];
      doc.transact(() => {
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes.get(index);
          const nodeJson = node?.toJSON?.() || node;
          if (!targetSet.has(nodeJson?.id)) continue;

          const currentPosition = nodeJson.position || {};
          const explicit = positions[nodeJson.id] || {};
          const next = {
            ...nodeJson,
            position: {
              ...currentPosition,
              x: explicit.x !== undefined ? Number(explicit.x) : (Number(currentPosition.x) || 0) + deltaX,
              y: explicit.y !== undefined ? Number(explicit.y) : (Number(currentPosition.y) || 0) + deltaY
            }
          };
          nodes.delete(index, 1);
          nodes.insert(index, [toYValue(Y, next)]);
          moved.push({ nodeId: nodeJson.id, from: currentPosition, to: next.position });
        }
      });
      const missing = targetIds.filter((id) => !moved.some((item) => item.nodeId === id));
      return { moved, missing, counts: { moved: moved.length, missing: missing.length } };
    });
  };

  const deleteElements = async ({ ids = [], nodeIds = [], edgeIds = [], ...command } = {}) =>
    withCanvasMutation({ type: "canvas.deleteElements", ...command }, ({ nodes, edges }) => {
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
      } else if (command.type === "canvas.summary") {
        result = await summarizeCanvas(command);
      } else if (command.type === "canvas.rollbackList") {
        result = rollbackStack.map(({ before, after, ...entry }) => ({
          ...entry,
          before: { nodes: before.nodes.length, edges: before.edges.length },
          after: { nodes: after.nodes.length, edges: after.edges.length }
        }));
      } else if (command.type === "canvas.rollback") {
        result = await rollbackCanvas(command);
      } else if (command.type === "canvas.restoreSnapshot") {
        result = await replaceCanvasSnapshot(command);
      } else if (command.type === "canvas.capabilities") {
        result = canvasCapabilities();
      } else if (command.type === "canvas.findElements") {
        result = await findElements(command.query || command);
      } else if (command.type === "canvas.suggestEmptyRegion") {
        result = await suggestEmptyRegion(command);
      } else if (command.type === "canvas.getElement") {
        result = await getElement(command);
      } else if (command.type === "canvas.inspectNodeTemplate") {
        result = await inspectNodeTemplate(command);
      } else if (command.type === "canvas.inspectModelOptions") {
        result = inspectModelOptions(command);
      } else if (command.type === "canvas.resolveModelAlias") {
        result = resolveModelAlias(command);
      } else if (command.type === "canvas.getConnections") {
        result = await getConnections(command);
      } else if (command.type === "canvas.createTextWorkflow") {
        result = await createTextWorkflow(command.config || {}, command);
      } else if (command.type === "canvas.createTextNode") {
        result = await createTextNode(command.config || {}, command);
      } else if (command.type === "canvas.createTextNodes") {
        result = await createTextNodes(command.config || command.configs || [], command);
      } else if (command.type === "canvas.groupElements") {
        result = await groupElements(command);
      } else if (command.type === "canvas.createNode") {
        result = await createNode(command.config || {}, command);
      } else if (command.type === "canvas.createVideoNode") {
        result = await createVideoNode(command.config || {}, command);
      } else if (command.type === "canvas.createImageNode") {
        result = await createImageNode(command.config || {}, command);
      } else if (command.type === "canvas.createReferenceImageNode") {
        result = await createReferenceImageNode(command.config || {}, command);
      } else if (command.type === "canvas.createReferenceFromUrl") {
        result = await createReferenceFromUrl(command);
      } else if (command.type === "canvas.uploadReferenceImage") {
        result = await uploadReferenceImage(command);
      } else if (command.type === "canvas.uploadLocalReferenceImage") {
        result = await uploadLocalReferenceImage(command);
      } else if (command.type === "canvas.prepareVideoNode") {
        result = await prepareVideoNode(command);
      } else if (command.type === "canvas.validateVideoRun") {
        result = await validateVideoRun(command);
      } else if (command.type === "canvas.validateNodeRun") {
        result = await validateNodeRun(command);
      } else if (command.type === "canvas.generateVideoNode") {
        result = await generateVideoNode(command);
      } else if (command.type === "canvas.runNode") {
        result = await runNode(command);
      } else if (command.type === "canvas.pollNodeResult") {
        result = await pollNodeResult(command);
      } else if (command.type === "canvas.pollTaskResult") {
        result = await pollTaskResult(command);
      } else if (command.type === "canvas.connectNodes") {
        result = await connectNodes(command);
      } else if (command.type === "canvas.updateNodeModel") {
        result = await updateNodeModel(command);
      } else if (command.type === "canvas.updateNodeParams") {
        result = await updateNodeParams(command);
      } else if (command.type === "canvas.updateNode") {
        result = await updateNode(command);
      } else if (command.type === "canvas.updateNodePosition") {
        result = await updateNodePosition(command);
      } else if (command.type === "canvas.moveNodes") {
        result = await moveNodes(command);
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
        errorCode: errorCodeFromError(error),
        error: error && error.stack ? error.stack : String(error)
      });
    }
  };

  const pollCommands = async () => {
    try {
      const versionResponse = await fetch(`${BRIDGE}/runtime-version`, { mode: "cors", cache: "no-store" });
      if (versionResponse.ok) {
        const version = await versionResponse.json();
        if (version.version && version.version !== RUNTIME_VERSION) {
          postEvent({ kind: "bridge.runtime.stale", currentVersion: RUNTIME_VERSION, nextVersion: version.version });
          const runtimeResponse = await fetch(`${BRIDGE}/bridge-runtime.js?ts=${Date.now()}`, { mode: "cors", cache: "no-store" });
          if (!runtimeResponse.ok) throw new Error(`Failed to reload runtime: ${runtimeResponse.status}`);
          const code = await runtimeResponse.text();
          new Function(`${code}\n//# sourceURL=runninghub-canvas-bridge-runtime.js`)();
          return;
        }
      }
      const response = await fetch(`${BRIDGE}/commands?clientId=${encodeURIComponent(CLIENT_ID)}&href=${encodeURIComponent(location.href)}`, {
        mode: "cors"
      });
      if (response.ok) {
        const commands = await response.json();
        for (const command of commands) await executeCommand(command);
      }
    } catch {}
    pollTimer = setTimeout(pollCommands, 700);
  };

  originalFetch = window.fetch.bind(window);
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

  OriginalXHR = window.XMLHttpRequest;
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

  OriginalWebSocket = window.WebSocket;
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
    version: RUNTIME_VERSION,
    graph: summarizeGraph,
    capabilities: canvasCapabilities,
    commands: COMMAND_CAPABILITIES.map((capability) => capability.type)
  };

  window.__RUNNINGHUB_CANVAS_BRIDGE_CLEANUP__ = () => {
    if (pollTimer) clearTimeout(pollTimer);
    if (originalFetch) window.fetch = originalFetch;
    if (OriginalXHR) window.XMLHttpRequest = OriginalXHR;
    if (OriginalWebSocket) {
      window.WebSocket = OriginalWebSocket;
      window.WebSocket.prototype = OriginalWebSocket.prototype;
    }
    window.__RUNNINGHUB_CANVAS_BRIDGE_INSTALLED__ = false;
  };

  postEvent({ kind: "bridge.installed", graph: summarizeGraph() });
  pollCommands();
})();
