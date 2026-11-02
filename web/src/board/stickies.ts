import { convertToExcalidrawElements, FONT_FAMILY } from "@excalidraw/excalidraw";

type Skeleton = Parameters<typeof convertToExcalidrawElements>[0] extends (infer T)[] | null ? T : never;

export const STICKY_COLORS = [
  { name: "Amarillo", value: "#FFF59D" },
  { name: "Naranja", value: "#FFCC80" },
  { name: "Rosa", value: "#F8BBD0" },
  { name: "Verde", value: "#C5E1A5" },
  { name: "Azul", value: "#B3E5FC" },
  { name: "Violeta", value: "#D1C4E9" },
  { name: "Gris", value: "#E0E0E0" },
] as const;

export const STICKY_SIZE = 200;

/**
 * Text inside containers is wrapped using measured widths, so the font must be loaded first;
 * otherwise the fallback font is measured and the real Nunito overflows the sticky note.
 */
export async function ensureCanvasFont(): Promise<void> {
  const spec = "20px Nunito";
  if (document.fonts.check(spec)) return;
  await Promise.race([document.fonts.load(spec).catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
}
export const INK = "#1A0F0C";

let counter = 0;
export function skeletonId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 7)}`;
}

/** A Miro-style sticky note: square, solid colour, no outline, centred clean text. */
export function stickySkeleton(opts: { x: number; y: number; text?: string; color?: string; size?: number; id?: string }): Skeleton {
  const size = opts.size ?? STICKY_SIZE;
  return {
    type: "rectangle",
    id: opts.id ?? skeletonId("sticky"),
    x: opts.x,
    y: opts.y,
    width: size,
    height: size,
    backgroundColor: opts.color ?? STICKY_COLORS[0].value,
    fillStyle: "solid",
    strokeColor: "transparent",
    strokeWidth: 1,
    roughness: 0,
    roundness: { type: 3 },
    customData: { sticky: true },
    label: {
      text: opts.text ?? "",
      fontSize: 20,
      fontFamily: FONT_FAMILY.Nunito,
      textAlign: "center",
      verticalAlign: "middle",
      strokeColor: INK,
    },
  } as Skeleton;
}

export function textSkeleton(opts: { x: number; y: number; text: string; fontSize?: number; color?: string }): Skeleton {
  return {
    type: "text",
    x: opts.x,
    y: opts.y,
    text: opts.text,
    fontSize: opts.fontSize ?? 28,
    fontFamily: FONT_FAMILY.Nunito,
    strokeColor: opts.color ?? INK,
    roughness: 0,
  } as Skeleton;
}

export function boxSkeleton(opts: {
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  fill?: string;
  stroke?: string;
  shape?: "rectangle" | "ellipse" | "diamond";
  fontSize?: number;
  id?: string;
}): Skeleton {
  return {
    type: opts.shape ?? "rectangle",
    id: opts.id ?? skeletonId("box"),
    x: opts.x,
    y: opts.y,
    width: opts.width,
    height: opts.height,
    backgroundColor: opts.fill ?? "transparent",
    fillStyle: "solid",
    strokeColor: opts.stroke ?? INK,
    strokeWidth: 2,
    roughness: 0,
    roundness: opts.shape === "rectangle" || !opts.shape ? { type: 3 } : null,
    ...(opts.text
      ? {
          label: {
            text: opts.text,
            fontSize: opts.fontSize ?? 20,
            fontFamily: FONT_FAMILY.Nunito,
            strokeColor: INK,
          },
        }
      : {}),
  } as Skeleton;
}

export function frameSkeleton(opts: { name: string; children: string[]; x: number; y: number; width: number; height: number }): Skeleton {
  return { type: "frame", name: opts.name, children: opts.children, x: opts.x, y: opts.y, width: opts.width, height: opts.height } as Skeleton;
}

export function arrowSkeleton(opts: { from: string; to: string; x: number; y: number; label?: string }): Skeleton {
  return {
    type: "arrow",
    x: opts.x,
    y: opts.y,
    strokeColor: INK,
    strokeWidth: 2,
    roughness: 0,
    start: { id: opts.from },
    end: { id: opts.to },
    ...(opts.label ? { label: { text: opts.label, fontFamily: FONT_FAMILY.Nunito, fontSize: 16 } } : {}),
  } as Skeleton;
}

export type { Skeleton };
