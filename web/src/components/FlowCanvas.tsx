// n8n-style flow editor: drag nodes from the palette onto the canvas, connect them, configure them
// in the side panel. Trigger, consent gate and approval are locked: visible but not deletable.
// Steps the trigger cannot reach are flagged: they would never run.
import {
  Background,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import clsx from "clsx";
import { Lock, Maximize2, Minus, Plus, Trash2, TriangleAlert, Unlink } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Flow, FlowNode, NodeDef, NodeKind, Settings, ShowIfOp, Vocabulary } from "../../../shared/types";
import type { ShowIfField } from "../api/client";
import { chLabel, evLabel, humanize } from "../lib/format";
import { Button, Field, Input, Select, Textarea, iconFor } from "./ui";

export interface FlowCatalog {
  nodes: NodeDef[];
  triggers: { key: string; label: string; hint?: string }[];
  fields: ShowIfField[];
  templates: { id: string; name: string }[];
}

const GROUP_TINT: Record<string, string> = {
  Triggers: "bg-sun-100 text-navy-950",
  Logic: "bg-ink-100 text-ink-700",
  AI: "bg-violet-50 text-violet-600",
  Actions: "bg-navy-50 text-navy-700",
  Commands: "bg-teal-50 text-teal-600",
  Safety: "bg-good-50 text-good-600",
};

let seq = 0;
const nid = (p: string) => `${p}-${Date.now().toString(36)}${(seq++).toString(36)}`;

const ENGAGEMENT_FIELDS: ShowIfField[] = [
  { field: "opened", label: "Opened the message", kind: "bool" },
  { field: "clicked", label: "Clicked", kind: "bool" },
  { field: "converted", label: "Bought the offer", kind: "bool" },
];

/** The comparisons an if/else step offers, by the kind of customer property. */
const COND_OPS: Record<ShowIfField["kind"], { value: ShowIfOp; label: string }[]> = {
  bool: [
    { value: "is", label: "is" },
    { value: "is_not", label: "is not" },
  ],
  number: [
    { value: "gt", label: "greater than" },
    { value: "lt", label: "less than" },
    { value: "is", label: "equals" },
  ],
  text: [
    { value: "is", label: "is" },
    { value: "is_not", label: "is not" },
  ],
  list: [
    { value: "contains", label: "includes" },
    { value: "not_contains", label: "does not include" },
  ],
};
const OP_WORDS: Record<string, string> = { is: "is", is_not: "is not", gt: "is greater than", lt: "is less than", contains: "includes", not_contains: "does not include", exists: "is set", not_exists: "is not set" };

/** Steps the trigger cannot reach by following the connections: they never run. */
export function unconnectedSteps(flow: Flow): FlowNode[] {
  const reached = new Set<string>();
  const todo = flow.nodes.filter((n) => n.kind === "trigger").map((n) => n.id);
  while (todo.length) {
    const id = todo.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const e of flow.edges) if (e.source === id) todo.push(e.target);
  }
  return flow.nodes.filter((n) => !reached.has(n.id));
}

/** The name of a step as shown on the canvas. */
const stepTitle = (n: FlowNode, def: NodeDef | undefined, settings: Settings | null) =>
  n.kind === "command" ? (settings?.commands.find((c) => c.id === n.config.commandId)?.name ?? "Command") : (def?.label ?? humanize(n.kind));

/** One-line description of a node, mirroring the server's flow summary. */
export function describeNode(n: FlowNode, cat: FlowCatalog | null, settings?: Settings | null, vocab?: Vocabulary | null): string {
  const c = n.config;
  switch (n.kind) {
    case "trigger": {
      if (c.event === "campaign_sent") return "When the campaign message was sent";
      if (c.event === "schedule") return c.schedule === "segment" ? `Every morning: segment ${String(c.segment ?? "").replace(/_/g, " ")}` : `Every morning: guarantee ends within ${c.days ?? 90} days`;
      const label = cat?.triggers.find((t) => t.key === c.event)?.label ?? evLabel(String(c.event ?? ""));
      return c.contains ? `${label} containing “${c.contains}”` : label;
    }
    case "gate":
      return "Consent per channel and profiling consent. No sales during dunning, complaints or cancellations.";
    case "approval":
      return `A person (${c.role ?? "Marketing"}) approves each message`;
    case "condition": {
      const f = [...ENGAGEMENT_FIELDS, ...(cat?.fields ?? [])].find((x) => x.field === c.field)?.label ?? String(c.field ?? "").replace(/_/g, " ");
      const v = typeof c.value === "boolean" ? (c.value ? "yes" : "no") : String(c.value ?? "");
      return `“${f}” ${OP_WORDS[String(c.op ?? "is")] ?? String(c.op).replace(/_/g, " ")} ${v}`.trim();
    }
    case "wait":
      return `${c.days} day${Number(c.days) === 1 ? "" : "s"}`;
    case "split":
      return `${Math.round(Number(c.shareA ?? 0.5) * 100)} % path A · ${100 - Math.round(Number(c.shareA ?? 0.5) * 100)} % path B`;
    case "ai_offer":
      return c.mode === "pinned" ? `Fixed offer: ${vocab?.offers.find((o) => o.offer_id === c.offerId)?.product_name ?? "none chosen yet"}` : "Highest expected CLV gain";
    case "ai_write":
      return String(c.instruction || "Fills the template's AI paragraphs");
    case "ai_classify":
      return "Upset customers get service, not offers";
    case "send":
    case "survey": {
      const t = cat?.templates.find((x) => x.id === c.templateId)?.name ?? (cat ? "no email chosen" : "");
      const what = n.kind === "send" ? chLabel(String(c.channel ?? "best")) : "Survey";
      return t ? `${what} · ${t}` : what;
    }
    case "task":
    case "notify":
      return `${c.team ?? ""}${c.text ? `: ${c.text}` : ""}`;
    case "voucher":
      return `${c.valueEur ?? 5} € shop voucher, same for everyone`;
    case "cancel_queued":
      return "Pending messages of this customer are cancelled";
    case "command":
      return settings?.commands.find((x) => x.id === c.commandId)?.description ?? "Custom command";
    case "stop":
      return "End of the flow";
  }
}

interface Ctx {
  cat: FlowCatalog | null;
  settings: Settings | null;
  vocab: Vocabulary | null;
}
const CatalogCtx = createContext<Ctx>({ cat: null, settings: null, vocab: null });

type StepData = { node: FlowNode; def?: NodeDef; orphan?: boolean };

function StepNode({ data, selected }: NodeProps<Node<StepData>>) {
  const { cat, settings, vocab } = useContext(CatalogCtx);
  const n = data.node;
  const def = data.def;
  const Icon = iconFor(def?.icon);
  const title = stepTitle(n, def, settings);
  const desc = describeNode(n, cat, settings, vocab);
  const branch = n.kind === "condition" ? ["yes", "no"] : n.kind === "split" ? ["a", "b"] : null;
  return (
    <div
      title={desc.length > 120 ? `${title}: ${desc}` : undefined}
      className={clsx(
        "relative w-[280px] rounded-xl border bg-white px-3 py-2.5 text-left shadow-[0_1px_2px_rgba(16,24,40,0.06)]",
        selected ? "border-navy-700 ring-2 ring-navy-100" : data.orphan ? "border-dashed border-warn-600 bg-warn-50" : n.locked && n.kind !== "trigger" ? "border-good-600/30" : "border-ink-200",
      )}
    >
      {data.orphan && (
        <span className="absolute -top-2.5 right-3 inline-flex items-center gap-1 rounded-full bg-warn-600 px-2 py-0.5 text-[10.5px] font-semibold text-white">
          <Unlink size={10} /> Not connected
        </span>
      )}
      {n.kind !== "trigger" && <Handle type="target" position={Position.Top} className="!h-3 !w-3 !border-2 !border-white !bg-ink-400" />}
      <div className="flex items-center gap-2">
        <span className={clsx("grid h-6 w-6 shrink-0 place-items-center rounded-md", GROUP_TINT[def?.group ?? "Logic"])}>
          <Icon size={13} />
        </span>
        <span className="min-w-0 flex-1 break-words text-[13.5px] font-semibold leading-tight text-ink-900">{title}</span>
        {n.locked && <Lock size={12} className="shrink-0 text-ink-400" aria-label="Locked" />}
      </div>
      {desc && <div className="mt-1 line-clamp-4 break-words text-[12.5px] leading-snug text-ink-500">{desc}</div>}
      {branch ? (
        <>
          <Handle id={branch[0]} type="source" position={Position.Bottom} style={{ left: "28%" }} className="!h-3 !w-3 !border-2 !border-white !bg-good-600" />
          <Handle id={branch[1]} type="source" position={Position.Bottom} style={{ left: "72%" }} className="!h-3 !w-3 !border-2 !border-white !bg-bad-600" />
          <div className="mt-1.5 flex justify-around text-[10.5px] font-medium uppercase tracking-wide text-ink-500">
            <span>{branch[0]}</span>
            <span>{branch[1]}</span>
          </div>
        </>
      ) : (
        n.kind !== "stop" && n.kind !== "cancel_queued" && <Handle type="source" position={Position.Bottom} className="!h-3 !w-3 !border-2 !border-white !bg-navy-700" />
      )}
    </div>
  );
}

const nodeTypes = { step: StepNode };

export interface FlowCanvasProps {
  flow: Flow;
  onChange: (f: Flow) => void;
  catalog: FlowCatalog | null;
  settings: Settings | null;
  vocab: Vocabulary | null;
  /** Campaign follow-ups start from "campaign sent" and may branch on engagement. */
  mode?: "automation" | "followup";
  readOnly?: boolean;
}

export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

const FIT = { padding: 0.08, maxZoom: 1 };

/** Zoom, zoom level and "Fit view" with words on them, top right where nothing floats over them. */
function CanvasToolbar() {
  const rf = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const icon = "grid h-8 w-8 place-items-center text-ink-700 hover:bg-ink-50 hover:text-ink-950";
  return (
    <Panel position="top-right">
      <div className="flex items-center overflow-hidden rounded-lg border border-ink-200 bg-white shadow-sm">
        <button type="button" onClick={() => void rf.zoomOut({ duration: 150 })} className={icon} aria-label="Zoom out" title="Zoom out">
          <Minus size={14} />
        </button>
        <button type="button" onClick={() => void rf.zoomTo(1, { duration: 150 })} className="num h-8 min-w-[52px] border-x border-ink-100 px-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-50" aria-label="Zoom level, click for 100 %" title="Back to 100 %">
          {Math.round(zoom * 100)} %
        </button>
        <button type="button" onClick={() => void rf.zoomIn({ duration: 150 })} className={icon} aria-label="Zoom in" title="Zoom in">
          <Plus size={14} />
        </button>
        <button type="button" onClick={() => void rf.fitView({ ...FIT, duration: 300 })} className="flex h-8 items-center gap-1.5 border-l border-ink-100 px-2.5 text-[12.5px] font-medium text-ink-800 hover:bg-ink-50" title="Show the whole flow">
          <Maximize2 size={13} /> Fit view
        </button>
      </div>
      <div className="mt-1 text-right text-[11px] text-ink-500">Scroll to zoom · drag the background to move</div>
    </Panel>
  );
}

function CanvasInner({ flow, onChange, catalog, settings, vocab, mode = "automation", readOnly }: FlowCanvasProps) {
  const rf = useReactFlow();
  const defs = useMemo(() => new Map((catalog?.nodes ?? []).map((d) => [d.kind === "command" ? `command:${d.commandId}` : d.kind, d])), [catalog]);
  const defOf = useCallback((n: FlowNode) => defs.get(n.kind === "command" ? `command:${n.config.commandId}` : n.kind) ?? defs.get(n.kind), [defs]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const orphans = useMemo(() => unconnectedSteps(flow), [flow]);

  // Rebuild the canvas from the flow, keeping xyflow's measurements and selection.
  useEffect(() => {
    const orphanIds = new Set(orphans.map((n) => n.id));
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return flow.nodes.map((n) => ({
        ...(byId.get(n.id) ?? {}),
        id: n.id,
        type: "step",
        position: n.position,
        data: { node: n, def: defOf(n), orphan: orphanIds.has(n.id) },
        deletable: !n.locked && !readOnly,
        selected: n.id === selectedId,
      }));
    });
    setEdges((prev) => {
      const byId = new Map(prev.map((e) => [e.id, e]));
      const lockedIds = new Set(flow.nodes.filter((n) => n.kind === "trigger" || n.kind === "gate").map((n) => n.id));
      return flow.edges.map((e) => ({
        ...(byId.get(e.id) ?? {}),
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        type: "smoothstep",
        label: e.sourceHandle ?? undefined,
        labelStyle: { fontSize: 11, fill: "#586480", textTransform: "uppercase" },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "#8b96ab" },
        style: { stroke: "#8b96ab", strokeWidth: 1.5 },
        deletable: !readOnly && !(lockedIds.has(e.source) && flow.nodes.find((n) => n.id === e.target)?.kind === "gate"),
      }));
    });
  }, [flow, defOf, readOnly, selectedId, orphans]);

  const emit = (nodesNext: FlowNode[], edgesNext = flow.edges) => onChange({ nodes: nodesNext, edges: edgesNext });

  const onNodesChange = (changes: NodeChange[]) => {
    if (readOnly) return;
    setNodes((ns) => applyNodeChanges(changes, ns));
    const removed = changes.filter((c) => c.type === "remove").map((c) => (c as { id: string }).id);
    const moved = changes.filter((c) => c.type === "position" && c.dragging === false) as { id: string; position?: { x: number; y: number } }[];
    for (const c of changes) if (c.type === "select" && c.selected) setSelectedId(c.id);
    if (removed.length || moved.length) {
      const latest = new Map(rf.getNodes().map((n) => [n.id, n.position]));
      const next = flow.nodes
        .filter((n) => !removed.includes(n.id) || n.locked)
        .map((n) => ({ ...n, position: moved.find((m) => m.id === n.id)?.position ?? latest.get(n.id) ?? n.position }));
      emit(
        next,
        flow.edges.filter((e) => !removed.includes(e.source) && !removed.includes(e.target)),
      );
      if (removed.includes(selectedId ?? "")) setSelectedId(null);
    }
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    if (readOnly) return;
    setEdges((es) => applyEdgeChanges(changes, es));
    const removed = changes.filter((c) => c.type === "remove").map((c) => (c as { id: string }).id);
    if (removed.length) emit(flow.nodes, flow.edges.filter((e) => !removed.includes(e.id)));
  };

  const onConnect = (c: Connection) => {
    if (readOnly || !c.source || !c.target || c.source === c.target) return;
    // One outgoing edge per handle: reconnecting replaces the old one.
    const rest = flow.edges.filter((e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null)));
    emit(flow.nodes, [...rest, { id: nid("e"), source: c.source, target: c.target, sourceHandle: c.sourceHandle ?? null }]);
  };

  const onDrop = (ev: React.DragEvent) => {
    ev.preventDefault();
    if (readOnly) return;
    const raw = ev.dataTransfer.getData("application/kompass-node");
    if (!raw) return;
    const def = JSON.parse(raw) as NodeDef;
    const position = rf.screenToFlowPosition({ x: ev.clientX - 140, y: ev.clientY - 20 });
    const node: FlowNode = { id: nid("n"), kind: def.kind as NodeKind, position, config: structuredClone(def.defaults) };
    emit([...flow.nodes, node]);
    setSelectedId(node.id);
  };

  /** Click on a palette step: append it below the selected step (or the end of the flow) and connect it. */
  const addFromPalette = (def: NodeDef) => {
    if (readOnly) return;
    const hasOut = (n: FlowNode) => {
      const outs = flow.edges.filter((e) => e.source === n.id);
      return n.kind === "condition" || n.kind === "split" ? outs.length >= 2 : outs.length >= 1;
    };
    const terminal = (n: FlowNode) => n.kind === "stop" || n.kind === "cancel_queued";
    const from =
      flow.nodes.find((n) => n.id === selectedId && !terminal(n)) ??
      [...flow.nodes].sort((a, b) => b.position.y - a.position.y).find((n) => !terminal(n) && !hasOut(n));
    const position = from ? { x: from.position.x, y: from.position.y + 130 } : { x: 0, y: 0 };
    const node: FlowNode = { id: nid("n"), kind: def.kind as NodeKind, position, config: structuredClone(def.defaults) };
    let edges = flow.edges;
    if (from) {
      const used = new Set(flow.edges.filter((e) => e.source === from.id).map((e) => e.sourceHandle ?? null));
      const handle = from.kind === "condition" ? (["yes", "no"].find((h) => !used.has(h)) ?? null) : from.kind === "split" ? (["a", "b"].find((h) => !used.has(h)) ?? null) : null;
      const branching = from.kind === "condition" || from.kind === "split";
      if (!branching || handle) {
        // Insert between the step and what followed it.
        const next = !branching ? flow.edges.find((e) => e.source === from.id) : undefined;
        edges = flow.edges.filter((e) => e !== next);
        edges = [...edges, { id: nid("e"), source: from.id, target: node.id, sourceHandle: handle }];
        if (next && !terminal(node)) edges.push({ id: nid("e"), source: node.id, target: next.target });
        if (next) {
          const shift = new Set<string>();
          const walk = (id: string) => {
            if (shift.has(id)) return;
            shift.add(id);
            flow.edges.filter((e) => e.source === id).forEach((e) => walk(e.target));
          };
          walk(next.target);
          emit([...flow.nodes.map((n) => (shift.has(n.id) ? { ...n, position: { ...n.position, y: n.position.y + 130 } } : n)), node], edges);
          setSelectedId(node.id);
          return;
        }
      }
    }
    emit([...flow.nodes, node], edges);
    setSelectedId(node.id);
  };

  /** Select a step and bring it into view, e.g. from the list of unconnected steps. */
  const focusNode = (id: string) => {
    setSelectedId(id);
    void rf.fitView({ nodes: [{ id }], padding: 0.3, maxZoom: 1, duration: 300 });
  };

  const selected = flow.nodes.find((n) => n.id === selectedId) ?? null;
  const updateNode = (n: FlowNode) => emit(flow.nodes.map((x) => (x.id === n.id ? n : x)));
  const removeNode = (n: FlowNode) => {
    emit(
      flow.nodes.filter((x) => x.id !== n.id),
      flow.edges.filter((e) => e.source !== n.id && e.target !== n.id),
    );
    setSelectedId(null);
  };

  const palette = (catalog?.nodes ?? []).filter((d) => d.group !== "Triggers" && d.group !== "Safety");
  const groups = ["Logic", "AI", "Actions", "Commands"];
  const fields = mode === "followup" ? [...ENGAGEMENT_FIELDS, ...(catalog?.fields ?? [])] : (catalog?.fields ?? []);

  // Two unconnected steps with the same name get their description, so the list tells them apart.
  const titles = orphans.map((n) => stepTitle(n, defOf(n), settings));
  const orphanLabel = (n: FlowNode, i: number) => (titles.filter((t) => t === titles[i]).length > 1 ? `${titles[i]}: ${describeNode(n, catalog, settings, vocab)}` : titles[i]);

  return (
    <CatalogCtx.Provider value={{ cat: catalog, settings, vocab }}>
      <div className="flex h-full min-h-0">
        {!readOnly && (
          <aside className="w-[220px] shrink-0 overflow-y-auto page-scroll border-r border-ink-200 bg-white px-3 py-4 scroll-thin">
            <div className="mb-3 px-1 text-[11.5px] text-ink-500">Drag steps onto the canvas and connect the dots, or click a step to add it below the selected one.</div>
            {groups.map((g) => {
              const items = palette.filter((d) => d.group === g);
              if (!items.length) return null;
              return (
                <div key={g} className="mb-4">
                  <div className="mb-1 px-1 text-[11.5px] font-semibold uppercase tracking-wider text-ink-400">{g === "Commands" ? "Your commands" : g}</div>
                  {items.map((d) => {
                    const Icon = iconFor(d.icon);
                    return (
                      <div
                        key={d.kind + (d.commandId ?? "")}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("application/kompass-node", JSON.stringify(d));
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onClick={() => addFromPalette(d)}
                        title={`${d.description} Click to add below the selected step, or drag onto the canvas.`}
                        className="flex cursor-grab items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-ink-50 active:cursor-grabbing"
                      >
                        <span className={clsx("grid h-6 w-6 shrink-0 place-items-center rounded-md", GROUP_TINT[d.group])}>
                          <Icon size={13} />
                        </span>
                        <span className="min-w-0 break-words font-medium leading-tight text-ink-800">{d.label}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          {orphans.length > 0 && (
            <div role="alert" className="flex shrink-0 items-start gap-2 border-b border-warn-600/25 bg-warn-50 px-4 py-2 text-[12.5px] text-ink-800">
              <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warn-600" />
              <div className="min-w-0 flex-1">
                <span className="font-semibold text-warn-600">
                  {orphans.length} {orphans.length === 1 ? "step is" : "steps are"} not connected and will never run.
                </span>{" "}
                Connect {orphans.length === 1 ? "it" : "them"} to the flow{readOnly ? "" : ` or remove ${orphans.length === 1 ? "it" : "them"}`}:
                <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
                  {orphans.map((n, i) => (
                    <button key={n.id} type="button" onClick={() => focusNode(n.id)} title="Show on the canvas" className="max-w-full break-words rounded-md border border-warn-600/30 bg-white px-1.5 py-0.5 text-left text-[12px] font-medium text-ink-800 hover:bg-warn-50">
                      {orphanLabel(n, i)}
                    </button>
                  ))}
                </span>
              </div>
            </div>
          )}
          <div className="relative min-h-0 flex-1 bg-[#f4f5f7]" onDragOver={(e) => (e.preventDefault(), (e.dataTransfer.dropEffect = "move"))} onDrop={onDrop}>
            <div className="absolute inset-0">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={(_, n) => setSelectedId(n.id)}
                onPaneClick={() => setSelectedId(null)}
                nodesDraggable={!readOnly}
                nodesConnectable={!readOnly}
                deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
                fitView
                fitViewOptions={FIT}
                minZoom={0.25}
                maxZoom={1.75}
                zoomOnScroll
                zoomOnPinch
                panOnScroll={false}
                connectionRadius={28}
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={18} size={1} color="#d5dae3" />
                <CanvasToolbar />
              </ReactFlow>
            </div>
          </div>
        </div>

        {selected && (
          <aside className="w-[300px] shrink-0 overflow-y-auto overflow-x-hidden page-scroll border-l border-ink-200 bg-white px-4 py-4 scroll-thin">
            <NodeConfig node={selected} def={defOf(selected)} catalog={catalog} settings={settings} vocab={vocab} fields={fields} mode={mode} readOnly={readOnly} onChange={updateNode} onRemove={() => removeNode(selected)} />
          </aside>
        )}
      </div>
    </CatalogCtx.Provider>
  );
}

/** The yes/no test of an if/else step: one condition, stacked so it fits the 300 px panel. */
function ConditionEditor({ config, fields, onChange }: { config: Record<string, unknown>; fields: ShowIfField[]; onChange: (patch: Record<string, unknown>) => void }) {
  const field = String(config.field ?? fields[0]?.field ?? "");
  const known = fields.some((f) => f.field === field);
  const kind = fields.find((f) => f.field === field)?.kind ?? "text";
  const ops = COND_OPS[kind];
  const op = ops.some((o) => o.value === config.op) ? String(config.op) : ops[0].value;
  return (
    <div className="min-w-0 space-y-2">
      <div className="text-[12px] font-medium text-ink-600">Go the “yes” way if</div>
      <Select
        value={field}
        onChange={(e) => {
          const k = fields.find((f) => f.field === e.target.value)?.kind ?? "text";
          onChange({ field: e.target.value, op: COND_OPS[k][0].value, value: k === "bool" ? true : "" });
        }}
        options={[...(known ? [] : [{ value: field, label: field.replace(/_/g, " ") }]), ...fields.map((f) => ({ value: f.field, label: f.label }))]}
        className="w-full min-w-0 truncate"
        aria-label="Customer property"
      />
      <div className="flex min-w-0 items-center gap-1.5">
        <Select value={op} onChange={(e) => onChange({ op: e.target.value })} options={ops} className="min-w-0 flex-1 truncate" aria-label="Comparison" />
        {kind === "bool" ? (
          <Select
            value={String(config.value ?? true)}
            onChange={(e) => onChange({ value: e.target.value === "true" })}
            options={[
              { value: "true", label: "yes" },
              { value: "false", label: "no" },
            ]}
            className="w-20 flex-none"
            aria-label="Value"
          />
        ) : (
          <Input
            type={kind === "number" ? "number" : "text"}
            value={String(config.value ?? "")}
            onChange={(e) => onChange({ value: kind === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value })}
            className="min-w-0 flex-1"
            placeholder={kind === "number" ? "Number" : "Value"}
            aria-label="Value"
          />
        )}
      </div>
      <p className="text-[11.5px] text-ink-500">Everyone else goes the “no” way.</p>
    </div>
  );
}

function NodeConfig({
  node,
  def,
  catalog,
  settings,
  vocab,
  fields,
  mode,
  readOnly,
  onChange,
  onRemove,
}: {
  node: FlowNode;
  def?: NodeDef;
  catalog: FlowCatalog | null;
  settings: Settings | null;
  vocab: Vocabulary | null;
  fields: ShowIfField[];
  mode: "automation" | "followup";
  readOnly?: boolean;
  onChange: (n: FlowNode) => void;
  onRemove: () => void;
}) {
  const c = node.config;
  const set = (patch: Record<string, unknown>) => onChange({ ...node, config: { ...c, ...patch } });
  const Icon = iconFor(def?.icon);
  const templates = [{ value: "", label: "Choose an email…" }, ...(catalog?.templates ?? []).map((t) => ({ value: t.id, label: t.name }))];
  const channels = ["best", "email", "newsletter", "portal_popup", "sms"].map((x) => ({ value: x, label: x === "best" ? "Best consented channel" : chLabel(x) }));

  let body: React.ReactNode = null;
  switch (node.kind) {
    case "trigger":
      body =
        mode === "followup" ? (
          <p className="text-[12.5px] text-ink-500">Starts for every customer who received this campaign's message.</p>
        ) : (
          <div className="space-y-2.5">
            <Field label="When">
              <Select value={String(c.event ?? "")} onChange={(e) => set({ event: e.target.value, ...(e.target.value === "schedule" ? { schedule: "guarantee_ends", days: 90 } : {}) })} options={(catalog?.triggers ?? []).map((t) => ({ value: t.key, label: t.label }))} />
            </Field>
            {c.event === "schedule" ? (
              <>
                <Field label="Customers">
                  <Select
                    value={String(c.schedule ?? "guarantee_ends")}
                    onChange={(e) => set({ schedule: e.target.value })}
                    options={[
                      { value: "guarantee_ends", label: "Price guarantee ends soon" },
                      { value: "segment", label: "In a segment" },
                    ]}
                  />
                </Field>
                {c.schedule === "segment" ? (
                  <Field label="Segment">
                    <Select value={String(c.segment ?? "")} onChange={(e) => set({ segment: e.target.value })} options={(vocab?.segments ?? []).map((s) => ({ value: s.key, label: s.key.replace(/_/g, " ") }))} />
                  </Field>
                ) : (
                  <Field label="Within days">
                    <Input type="number" min={1} max={365} value={Number(c.days ?? 90)} onChange={(e) => set({ days: Number(e.target.value) })} className="w-24" />
                  </Field>
                )}
              </>
            ) : (
              <Field label="Only if the event mentions" hint={catalog?.triggers.find((t) => t.key === c.event)?.hint ?? "Optional text filter, e.g. a product name"}>
                <Input value={String(c.contains ?? "")} onChange={(e) => set({ contains: e.target.value })} placeholder="e.g. Wallbox" />
              </Field>
            )}
          </div>
        );
      break;
    case "condition":
      body = <ConditionEditor config={c} fields={fields} onChange={set} />;
      break;
    case "wait":
      body = (
        <Field label="Wait">
          <div className="flex items-center gap-1.5">
            <Input type="number" min={1} max={60} value={Number(c.days ?? 1)} onChange={(e) => set({ days: Number(e.target.value) })} className="w-20" />
            <span className="text-[12.5px] text-ink-500">days</span>
          </div>
        </Field>
      );
      break;
    case "split":
      body = (
        <Field label="Share on path A">
          <div className="flex items-center gap-1.5">
            <Input type="number" min={5} max={95} value={Math.round(Number(c.shareA ?? 0.5) * 100)} onChange={(e) => set({ shareA: Number(e.target.value) / 100 })} className="w-20" />
            <span className="text-[12.5px] text-ink-500">%</span>
          </div>
        </Field>
      );
      break;
    case "ai_offer":
      body = (
        <div className="space-y-2.5">
          <Select
            value={c.mode === "pinned" ? "pinned" : "engine"}
            onChange={(e) => set({ mode: e.target.value })}
            options={[
              { value: "engine", label: "Engine picks the best offer" },
              { value: "pinned", label: "A fixed offer" },
            ]}
          />
          {c.mode === "pinned" && (
            <Select value={String(c.offerId ?? "")} onChange={(e) => set({ offerId: e.target.value })} options={(vocab?.offers ?? []).filter((o) => !o.disabled).map((o) => ({ value: o.offer_id, label: o.product_name }))} />
          )}
        </div>
      );
      break;
    case "ai_write":
      body = (
        <Field label="Instruction for the AI paragraphs">
          <Textarea rows={3} value={String(c.instruction ?? "")} onChange={(e) => set({ instruction: e.target.value })} />
        </Field>
      );
      break;
    case "send":
    case "survey":
      body = (
        <div className="space-y-2.5">
          {node.kind === "send" && (
            <Field label="Channel">
              <Select value={String(c.channel ?? "best")} onChange={(e) => set({ channel: e.target.value })} options={channels} />
            </Field>
          )}
          <Field label="Email" hint="Built in Emails with smart blocks.">
            <Select value={String(c.templateId ?? "")} onChange={(e) => set({ templateId: e.target.value })} options={templates} />
          </Field>
        </div>
      );
      break;
    case "task":
    case "notify":
      body = (
        <div className="space-y-2.5">
          <Field label="Team">
            <Input value={String(c.team ?? "")} onChange={(e) => set({ team: e.target.value })} />
          </Field>
          <Field label="What to do">
            <Textarea rows={2} value={String(c.text ?? "")} onChange={(e) => set({ text: e.target.value })} />
          </Field>
        </div>
      );
      break;
    case "voucher":
      body = (
        <Field label="Value" hint="Uniform for everyone: no personalised prices.">
          <div className="flex items-center gap-1.5">
            <Input type="number" min={1} max={50} value={Number(c.valueEur ?? 5)} onChange={(e) => set({ valueEur: Number(e.target.value) })} className="w-20" />
            <span className="text-[12.5px] text-ink-500">€</span>
          </div>
        </Field>
      );
      break;
    case "approval":
      body = (
        <Field label="Approved by">
          <Select value={String(c.role ?? "Marketing")} onChange={(e) => set({ role: e.target.value })} options={["Marketing", "Service lead", "CRM manager"].map((r) => ({ value: r, label: r }))} />
        </Field>
      );
      break;
    case "command": {
      const cmd = settings?.commands.find((x) => x.id === c.commandId);
      body = <p className="text-[12.5px] text-ink-500">{cmd ? `${cmd.description} · ${cmd.costEur ? `${cmd.costEur} € per use · ` : ""}${cmd.needsApproval ? "needs approval" : "no approval"}` : "Command not found"}</p>;
      break;
    }
    default:
      body = <p className="text-[12.5px] text-ink-500">{def?.description}</p>;
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center gap-2">
        <span className={clsx("grid h-7 w-7 shrink-0 place-items-center rounded-lg", GROUP_TINT[def?.group ?? "Logic"])}>
          <Icon size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="break-words text-[14px] font-semibold text-ink-950">{def?.label ?? humanize(node.kind)}</div>
          <div className="text-[11.5px] text-ink-500">{def?.group}</div>
        </div>
      </div>
      {node.locked && (
        <div className="flex items-start gap-2 rounded-lg bg-good-50 px-3 py-2 text-[12px] text-good-600">
          <Lock size={13} className="mt-0.5 shrink-0" />
          {node.kind === "trigger" ? "Every flow has exactly one trigger. You can change what it listens to." : "Built in for every flow. It cannot be removed."}
        </div>
      )}
      {/* A fieldset is as wide as its widest content unless it may shrink: min-w-0 keeps long selects inside the panel, where they are cut with an ellipsis. */}
      <fieldset disabled={readOnly} className="min-w-0 space-y-3 [&_select]:truncate">
        {body}
      </fieldset>
      {!node.locked && !readOnly && (
        <Button size="sm" variant="danger" icon={Trash2} onClick={onRemove}>
          Remove step
        </Button>
      )}
    </div>
  );
}
