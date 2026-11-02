// Template metadata only (no canvas code), so the dashboard stays light.
export type TemplateMeta = {
  id: string;
  name: string;
  description: string;
  category: "Talleres" | "Estrategia" | "Proyectos" | "Diagramas";
  emoji: string;
};

export const TEMPLATE_LIST: TemplateMeta[] = [
  { id: "retro", name: "Retrospectiva", description: "Qué fue bien, qué mejorar y acciones.", category: "Talleres", emoji: "🔁" },
  { id: "brainstorm", name: "Lluvia de ideas", description: "Pregunta central y notas por colores. Ideal con votación.", category: "Talleres", emoji: "💡" },
  { id: "swot", name: "DAFO", description: "Fortalezas, debilidades, oportunidades y amenazas.", category: "Estrategia", emoji: "🧭" },
  { id: "eisenhower", name: "Matriz de Eisenhower", description: "Prioriza por urgencia e importancia.", category: "Proyectos", emoji: "⏱️" },
  { id: "kanban", name: "Kanban", description: "Por hacer, en curso, en revisión y hecho.", category: "Proyectos", emoji: "📋" },
  { id: "journey", name: "Customer journey", description: "Fases del cliente: acciones, emociones y oportunidades.", category: "Estrategia", emoji: "🛤️" },
  { id: "bmc", name: "Business Model Canvas", description: "Los 9 bloques del modelo de negocio.", category: "Estrategia", emoji: "🧩" },
  { id: "roadmap", name: "Roadmap trimestral", description: "Tres meses con iniciativas por carril.", category: "Proyectos", emoji: "🗺️" },
  { id: "flowchart", name: "Diagrama de flujo", description: "Inicio, pasos, decisión y fin ya conectados.", category: "Diagramas", emoji: "🔀" },
];
