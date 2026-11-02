import {
  arrowSkeleton,
  boxSkeleton,
  frameSkeleton,
  type Skeleton,
  skeletonId,
  STICKY_COLORS,
  stickySkeleton,
  textSkeleton,
} from "./stickies";

/** Canvas builders for each template in `templateList.ts`, keyed by template id. */
type Template = { id: string; build: () => Skeleton[] };

const [yellow, orange, pink, green, blue, violet] = STICKY_COLORS.map((c) => c.value);

/** Columns of titled frames, each seeded with a couple of sticky notes. */
function columns(specs: { title: string; color: string; hint: string }[], opts: { width?: number; height?: number } = {}) {
  const width = opts.width ?? 520;
  const height = opts.height ?? 760;
  const gap = 60;
  const out: Skeleton[] = [];
  specs.forEach((spec, i) => {
    const x = i * (width + gap);
    const a = skeletonId("st");
    const b = skeletonId("st");
    out.push(stickySkeleton({ id: a, x: x + 40, y: 60, color: spec.color, text: spec.hint }));
    out.push(stickySkeleton({ id: b, x: x + 270, y: 60, color: spec.color }));
    out.push(frameSkeleton({ name: spec.title, children: [a, b], x, y: 0, width, height }));
  });
  return out;
}

function grid2x2(
  cells: { title: string; color: string }[],
  axes: { top: string; bottom: string; left: string; right: string },
) {
  const size = 560;
  const out: Skeleton[] = [];
  cells.forEach((cell, i) => {
    const x = (i % 2) * (size + 20);
    const y = Math.floor(i / 2) * (size + 20);
    out.push(boxSkeleton({ x, y, width: size, height: size, fill: cell.color, stroke: "transparent" }));
    out.push(textSkeleton({ x: x + 24, y: y + 20, text: cell.title, fontSize: 26 }));
  });
  out.push(textSkeleton({ x: size - 80, y: -60, text: axes.top, fontSize: 22 }));
  out.push(textSkeleton({ x: size - 80, y: 2 * size + 60, text: axes.bottom, fontSize: 22 }));
  out.push(textSkeleton({ x: -230, y: size, text: axes.left, fontSize: 22 }));
  out.push(textSkeleton({ x: 2 * size + 60, y: size, text: axes.right, fontSize: 22 }));
  return out;
}

const TEMPLATES: Template[] = [
  {
    id: "retro",
    build: () =>
      columns([
        { title: "Qué fue bien", color: green, hint: "Algo que repetiríamos" },
        { title: "Qué mejorar", color: pink, hint: "Algo que nos frenó" },
        { title: "Acciones", color: blue, hint: "Acción · responsable · fecha" },
      ]),
  },
  {
    id: "brainstorm",
    build: () => {
      const out: Skeleton[] = [textSkeleton({ x: 0, y: -120, text: "¿Cuál es la pregunta que queremos resolver?", fontSize: 36 })];
      const colors = [yellow, orange, pink, green, blue, violet];
      for (let i = 0; i < 12; i++) {
        out.push(stickySkeleton({ x: (i % 6) * 230, y: Math.floor(i / 6) * 230, color: colors[i % colors.length], text: i === 0 ? "Una idea por nota" : "" }));
      }
      return out;
    },
  },
  {
    id: "swot",
    build: () =>
      grid2x2(
        [
          { title: "Fortalezas", color: "#E8F5E9" },
          { title: "Debilidades", color: "#FFF3E0" },
          { title: "Oportunidades", color: "#E3F2FD" },
          { title: "Amenazas", color: "#FCE4EC" },
        ],
        { top: "Interno", bottom: "Externo", left: "Positivo", right: "Negativo" },
      ),
  },
  {
    id: "eisenhower",
    build: () =>
      grid2x2(
        [
          { title: "Hacer ya", color: "#FCE4EC" },
          { title: "Planificar", color: "#E3F2FD" },
          { title: "Delegar", color: "#FFF8E1" },
          { title: "Eliminar", color: "#F5F5F5" },
        ],
        { top: "Urgente ←→ No urgente", bottom: "", left: "Importante", right: "No importante" },
      ),
  },
  {
    id: "kanban",
    build: () =>
      columns(
        [
          { title: "Por hacer", color: yellow, hint: "Tarea" },
          { title: "En curso", color: blue, hint: "" },
          { title: "En revisión", color: violet, hint: "" },
          { title: "Hecho", color: green, hint: "" },
        ],
        { width: 480, height: 900 },
      ),
  },
  {
    id: "journey",
    build: () => {
      const phases = ["Descubre", "Considera", "Compra", "Usa", "Recomienda"];
      const rows = [
        { name: "Acciones", color: yellow },
        { name: "Puntos de contacto", color: blue },
        { name: "Emociones", color: pink },
        { name: "Oportunidades", color: green },
      ];
      const out: Skeleton[] = [];
      phases.forEach((phase, i) => out.push(boxSkeleton({ x: 240 + i * 240, y: 0, width: 220, height: 70, text: phase, fill: "#1A0F0C", stroke: "transparent" })));
      rows.forEach((row, r) => {
        out.push(textSkeleton({ x: 0, y: 110 + r * 240 + 80, text: row.name, fontSize: 22 }));
        phases.forEach((_, i) => out.push(stickySkeleton({ x: 250 + i * 240, y: 110 + r * 240, color: row.color })));
      });
      return out;
    },
  },
  {
    id: "bmc",
    build: () => {
      const u = 260;
      const blocks: [string, number, number, number, number][] = [
        ["Socios clave", 0, 0, 1, 2],
        ["Actividades clave", 1, 0, 1, 1],
        ["Recursos clave", 1, 1, 1, 1],
        ["Propuesta de valor", 2, 0, 1, 2],
        ["Relación con clientes", 3, 0, 1, 1],
        ["Canales", 3, 1, 1, 1],
        ["Segmentos de clientes", 4, 0, 1, 2],
        ["Estructura de costes", 0, 2, 2.5, 1],
        ["Fuentes de ingresos", 2.5, 2, 2.5, 1],
      ];
      return blocks.flatMap(([title, cx, cy, w, h]) => [
        boxSkeleton({ x: cx * u, y: cy * u, width: w * u - 10, height: h * u - 10, fill: "#FFFCF8", stroke: "#8C8079" }),
        textSkeleton({ x: cx * u + 16, y: cy * u + 14, text: title, fontSize: 18 }),
      ]);
    },
  },
  {
    id: "roadmap",
    build: () => {
      const months = ["Mes 1", "Mes 2", "Mes 3"];
      const lanes = [
        { name: "Producto", color: violet },
        { name: "Marketing", color: orange },
        { name: "Ventas", color: green },
      ];
      const out: Skeleton[] = [];
      months.forEach((m, i) => out.push(boxSkeleton({ x: 220 + i * 480, y: 0, width: 460, height: 64, text: m, fill: "#EFE6D8", stroke: "transparent" })));
      lanes.forEach((lane, r) => {
        out.push(textSkeleton({ x: 0, y: 120 + r * 260 + 70, text: lane.name, fontSize: 24 }));
        out.push(stickySkeleton({ x: 240 + r * 300, y: 100 + r * 260, color: lane.color, text: "Iniciativa" }));
      });
      return out;
    },
  },
  {
    id: "flowchart",
    build: () => {
      const start = skeletonId("n");
      const step = skeletonId("n");
      const decision = skeletonId("n");
      const yes = skeletonId("n");
      const end = skeletonId("n");
      return [
        boxSkeleton({ id: start, shape: "ellipse", x: 0, y: 0, width: 200, height: 90, text: "Inicio", fill: "#E8F5E9" }),
        boxSkeleton({ id: step, x: 0, y: 180, width: 200, height: 100, text: "Paso", fill: "#FFFCF8" }),
        boxSkeleton({ id: decision, shape: "diamond", x: -10, y: 370, width: 220, height: 160, text: "¿Decisión?", fill: "#FFF8E1" }),
        boxSkeleton({ id: yes, x: 340, y: 400, width: 200, height: 100, text: "Acción", fill: "#FFFCF8" }),
        boxSkeleton({ id: end, shape: "ellipse", x: 0, y: 620, width: 200, height: 90, text: "Fin", fill: "#FCE4EC" }),
        arrowSkeleton({ from: start, to: step, x: 100, y: 90 }),
        arrowSkeleton({ from: step, to: decision, x: 100, y: 280 }),
        arrowSkeleton({ from: decision, to: yes, x: 210, y: 450, label: "Sí" }),
        arrowSkeleton({ from: decision, to: end, x: 100, y: 530, label: "No" }),
      ];
    },
  },
];

export function buildTemplate(id: string): Skeleton[] | null {
  return TEMPLATES.find((t) => t.id === id)?.build() ?? null;
}
