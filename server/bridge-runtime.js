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
      type: "canvas.createNode",
      description: "Create one generic canvas node from a provided node template, type, position, and data. Supports dryRun."
    },
    {
      type: "canvas.createVideoNode",
      description: "Create one RunningHub native text-to-video rh-video node. Supports dryRun and optional upstream connection."
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

  const canvasCapabilities = () => ({
    bridgeVersion: 1,
    clientId: CLIENT_ID,
    href: location.href,
    commands: COMMAND_CAPABILITIES
  });

  const findElements = async (query = {}) =>
    withCanvasYjs(({ nodes, edges, canvasId }) => ({
      canvasId,
      query,
      ...findElementsInSnapshot({ nodes: yArrayToJson(nodes), edges: yArrayToJson(edges) }, query)
    }));

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
            webSearch: config.webSearch ?? false
          },
          modelCode: config.modelCode || "text-video-sparkvideo-2.0",
          generateNum: Number(config.generateNum || 1),
          subType: "text-video",
          title: config.title || "视频生成",
          type: "rh-video",
          status: "idle",
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
      return { nodeId, node, edges: addedEdges };
    });

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
      } else if (command.type === "canvas.getElement") {
        result = await getElement(command);
      } else if (command.type === "canvas.inspectNodeTemplate") {
        result = await inspectNodeTemplate(command);
      } else if (command.type === "canvas.getConnections") {
        result = await getConnections(command);
      } else if (command.type === "canvas.createTextWorkflow") {
        result = await createTextWorkflow(command.config || {}, command);
      } else if (command.type === "canvas.createTextNode") {
        result = await createTextNode(command.config || {}, command);
      } else if (command.type === "canvas.createNode") {
        result = await createNode(command.config || {}, command);
      } else if (command.type === "canvas.createVideoNode") {
        result = await createVideoNode(command.config || {}, command);
      } else if (command.type === "canvas.connectNodes") {
        result = await connectNodes(command);
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
    capabilities: canvasCapabilities,
    commands: COMMAND_CAPABILITIES.map((capability) => capability.type)
  };

  postEvent({ kind: "bridge.installed", graph: summarizeGraph() });
  pollCommands();
})();
