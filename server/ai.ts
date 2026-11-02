import Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "./auth.js";

// AI is opt-in: without ANTHROPIC_API_KEY every AI route answers `ai_disabled` and nothing is spent.
const enabled = Boolean(process.env.ANTHROPIC_API_KEY);
const model = process.env.LIENZO_AI_MODEL?.trim() || "claude-opus-5-5";
const client = enabled ? new Anthropic() : null;

const SYSTEM = `You turn a short description, usually in Spanish, into ONE Mermaid diagram for a whiteboard.
Rules:
- Reply with Mermaid source only: no code fences, no prose before or after.
- Use "flowchart TD" for processes and decisions, "sequenceDiagram" for interactions between actors,
  "mindmap" for idea maps, "classDiagram" or "erDiagram" for data models.
- Keep node labels short (max ~6 words) and in the user's language. Quote labels that contain punctuation.
- Aim for 5 to 25 nodes; prefer clarity over completeness.`;

function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:mermaid)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/ai/status", { preHandler: requireUser }, async () => ({ enabled }));

  app.post("/api/ai/mermaid", { preHandler: requireUser }, async (request, reply) => {
    if (!client) return reply.code(503).send({ error: "ai_disabled" });
    const { prompt } = z.object({ prompt: z.string().trim().min(3).max(4000) }).parse(request.body);
    try {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        output_config: { effort: "low" },
        // On a policy decline the API retries on a fallback model inside the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: SYSTEM,
        messages: [{ role: "user", content: prompt }],
      });
      if (response.stop_reason === "refusal") return reply.code(422).send({ error: "ai_refused" });
      const text = response.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const mermaid = stripFences(text);
      if (!mermaid) return reply.code(502).send({ error: "ai_empty" });
      return { mermaid };
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) return reply.code(429).send({ error: "ai_rate_limited" });
      if (error instanceof Anthropic.APIError) {
        request.log.error({ status: error.status }, "anthropic api error");
        return reply.code(502).send({ error: "ai_upstream_error" });
      }
      throw error;
    }
  });
}
