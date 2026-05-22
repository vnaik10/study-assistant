import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const AI_BASE_URL = (process.env.AI_BASE_URL || "https://openrouter.ai/api/v1")
  .replace(/\/+$/, "")
  .replace(/\/chat\/completions$/, "");
const AI_CHAT_ENDPOINT = `${AI_BASE_URL}/chat/completions`;

// ============================================================================
// TOKEN & CONTEXT MANAGEMENT
// ============================================================================

/** Rough token estimator: ~4 chars per token for English, ~2.5 for mixed */
function estimateTokens(text: string): number {
  const clean = text.trim();
  if (!clean) return 0;
  const codeHeaviness = (clean.match(/[{}[\];=+\-*\/<>]/g) || []).length / clean.length;
  const ratio = 3.5 + codeHeaviness * 1.5;
  return Math.ceil(clean.length / ratio);
}

/** Smart slicer that respects paragraph boundaries and token limits */
function sliceByTokens(text: string, maxTokens: number, reserveOutput = 1500): string {
  const availableInput = maxTokens - reserveOutput - 500;
  if (estimateTokens(text) <= availableInput) return text;

  const paragraphs = text.split(/\n\s*\n/);
  let result = "";
  let tokens = 0;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    if (tokens + paraTokens > availableInput) {
      const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
      for (const sent of sentences) {
        const sentTokens = estimateTokens(sent);
        if (tokens + sentTokens > availableInput) break;
        result += sent;
        tokens += sentTokens;
      }
      break;
    }
    result += para + "\n\n";
    tokens += paraTokens;
  }

  return result.trim() + (text.length > result.length ? "\n\n[Content truncated for context window]" : "");
}

/** Get model-specific max context */
function getModelContextLimit(): number {
  const model = process.env.AI_MODEL || "deepseek/deepseek-chat";
  if (model.includes("deepseek-chat") || model.includes("deepseek-coder")) return 64000;
  if (model.includes("claude")) return 200000;
  if (model.includes("gpt-4o")) return 128000;
  if (model.includes("gemini")) return 1000000;
  return 32000;
}

/**
 * Score document relevance to a question using keyword overlap.
 * Used to allocate token budget to the most relevant documents first.
 */
function scoreDocumentRelevance(docContent: string, question: string): number {
  const questionTokens = new Set(
    question.toLowerCase().match(/\b\w{4,}\b/g) || []
  );
  if (questionTokens.size === 0) return 0;
  const docLower = docContent.toLowerCase();
  let hits = 0;
  for (const token of questionTokens) {
    if (docLower.includes(token)) hits++;
  }
  return hits / questionTokens.size;
}

// ============================================================================
// SYSTEM PROMPT ARCHITECTURE
// ============================================================================

/**
 * DESIGN PRINCIPLE: Prompts are composed from focused building blocks.
 * Each block has a single responsibility. Task prompts only include
 * what that task genuinely needs — no bloat from unrelated rules.
 */

// --- Core grounding block (used everywhere) ---
const GROUNDING_BLOCK = `## Grounding Rule — Non-Negotiable
Every factual claim you make must be traceable to a specific passage in the provided study material.
Before writing any sentence, ask yourself: "Can I point to the exact text in the material that supports this?"
If yes → write it and append [Source: <document name>].
If no → write exactly: "This information is not present in the provided material."
Never infer, extrapolate, or supplement from general knowledge.`;

// --- Honesty block (used in chat tasks) ---
const HONESTY_BLOCK = `## Honesty Protocol
- If the material is ambiguous, say so: "The material suggests X, but this is not stated definitively."
- If the question is outside the material's scope: "I can only answer based on the provided document, and this topic is not covered."
- Never fabricate page numbers, author names, or dates not explicitly in the text.`;

// --- Format block (used in all tasks) ---
const FORMAT_BLOCK = `## Output Format Rules
- Use clean, valid markdown only. No raw HTML tags.
- Bold (**term**) key concepts on first use.
- Tables must use proper markdown pipe syntax with a header separator row.
- Use --- as a section divider between major sections, not inside lists.`;

// --- Exam pattern compliance block ---
const EXAM_PATTERN_BLOCK = `## Exam Pattern Compliance — This is Law
The exam pattern provided by the user is a hard constraint, not a suggestion.
Before writing your first question:
  1. Count the required modules.
  2. Verify marks per module and total.
  3. Identify which questions require internal choice.
After writing your last question:
  1. Recount module questions.
  2. Recount total marks.
  3. Verify internal choice indicators (OR / alternative questions) are present where required.
If any check fails, fix it before responding. Never submit an exam that doesn't add up.`;

// ============================================================================
// CHAIN-OF-THOUGHT SCAFFOLDS
// ============================================================================

/**
 * WHY CoT SCAFFOLDS?
 * For structured outputs (mock exams, study plans), asking the model to
 * reason step-by-step before producing output dramatically reduces
 * structural errors. We use a <scratchpad> block that gets stripped
 * from the final response at the callsite, keeping output clean.
 */

const MOCK_EXAM_COT_SCAFFOLD = `Before writing the exam, complete this planning block inside <scratchpad> tags:
<scratchpad>
1. Pattern parsing:
   - Total modules: [N]
   - Marks per module: [N]
   - Total marks: [N] — verify sum
   - Q1 type (compulsory/choice): [X]
   - Internal choice structure: [describe]

2. Material coverage check:
   - List one distinct topic per module from the material
   - Confirm each topic has enough content for [N] marks of questions

3. Question type allocation:
   - Short answer (2-4 marks): appropriate for [which sub-questions?]
   - Long answer (8-10 marks): appropriate for [which sub-questions?]
   - Diagram/derivation: available in [which modules?]
</scratchpad>

Only after completing the scratchpad, write the full exam.`;

const STUDY_PLAN_COT_SCAFFOLD = `Before writing the plan, complete this analysis inside <scratchpad> tags:
<scratchpad>
1. Time arithmetic:
   - Days available: [N]
   - Realistic study hours/day: [N] (be conservative)
   - Total hours: [N × N = N]

2. Module priority ranking (based on pattern repeat frequency and marks weight):
   - Module [X]: [justification] → [hours allocated]
   - ...

3. Phase boundaries:
   - Phase 1 ends: Day [N] — what must be complete?
   - Phase 2 ends: Day [N] — what must be complete?
   - Phase 3 focus: [exam simulation strategy]

4. Contingency: what gets cut if the student falls behind?
</scratchpad>

Only after completing the scratchpad, write the full plan.`;

// ============================================================================
// FEW-SHOT EXAMPLES (High-Quality, Task-Specific)
// ============================================================================

const FEW_SHOT_MOCK_EXAM = `## Reference: Correct Mock Exam Structure

**Input pattern:** 5 modules, 20 marks each, Q1 compulsory (all parts), Q2-Q6 internal choice (attempt any one part)

**Correct output structure:**

# Mock Exam: [Subject Name]
**Duration:** 3 Hours | **Max Marks:** 100
**Instructions:** Answer Q1 (compulsory). From Q2–Q6, attempt any ONE part per question.

---

## Q1 — Compulsory — 20 Marks
*(Answer all parts)*

**(a)** [Specific question about Module 1 concept] — **4 Marks**
**(b)** [Specific question about Module 2 concept] — **4 Marks**
**(c)** [Specific question about Module 3 concept] — **4 Marks**
**(d)** [Specific question about Module 4 concept] — **4 Marks**
**(e)** [Specific question about Module 5 concept] — **4 Marks**

---

## Q2 — Module 1 — 20 Marks
*(Attempt any ONE)*

**(a)** [Detailed analytical question requiring 10-mark depth] — **20 Marks**

**OR**

**(b)** [Alternative detailed question on same module] — **20 Marks**

---
[Q3 → Module 2, Q4 → Module 3, Q5 → Module 4, Q6 → Module 5 — same structure]

---
**SELF-CHECK:** Q1 = 5×4 = 20 ✓ | Q2-Q6 = 5×20 = 100 ✓ | Total = 100 ✓`;

const FEW_SHOT_STUDY_PLAN_PHASE = `## Reference: Correct Phase Structure

### PHASE 1: High-Yield Foundation (Days 1–[N])

**Goal:** Lock in guaranteed marks. Complete all Tier S questions.

**Module Focus:** [Module X — highest marks weight] + [Module Y — highest repeat rate in PYQs]

**Day-by-Day:**

**Day 1:**
- 07:00–09:00 → Read Module [X], sections [1.1–1.4]. Mark every definition and formula.
- 09:15–11:15 → Solve Tier S questions from Module [X]. Target: 3 long-answer questions drafted.
- 15:00–17:00 → Convert Module [X] notes into 10 flashcards. Self-test.
- **Deliverable:** Module [X] Tier S list complete with draft answers.

**Day 2:**
- 07:00–09:00 → Read Module [Y], sections [Y.1–Y.3].
- 09:15–11:15 → Map choice strategy for Q[N]: identify which part (a) or (b) appears more in PYQs.
- **Deliverable:** Choice decision locked for Q[N] and Q[N+1].`;

// ============================================================================
// RESPONSE VALIDATION & RETRY LOGIC
// ============================================================================

type Msg = { role: "system" | "user" | "assistant"; content: string };

interface ValidationRule {
  name: string;
  test: (content: string) => boolean;
  severity: "error" | "warning";
  fixPrompt: string;
}

/**
 * IMPROVED VALIDATION STRATEGY:
 * - Severity levels: "error" triggers retry, "warning" just logs.
 * - Rules are compositional: each tests one specific structural property.
 * - Fix prompts are surgical — they target the exact failure, not a
 *   generic "please redo" instruction that wastes the full context.
 */
const TASK_VALIDATIONS: Record<string, ValidationRule[]> = {
  mock_exam: [
    {
      name: "has_question_structure",
      severity: "error",
      test: (c) => /##\s*Q\d+/i.test(c) && /Q[1-9]/i.test(c),
      fixPrompt: "CRITICAL: Your response is missing the required Q1, Q2... question structure. Each question must be a ## heading. Regenerate the complete exam with this structure."
    },
    {
      name: "has_internal_choice_or",
      severity: "error",
      test: (c) => /\bOR\b/.test(c),
      fixPrompt: "CRITICAL: Internal choice questions (OR alternatives) are missing. Every Q2 onwards must have a Part (a) AND an alternative Part (b) separated by '**OR**'. Add these now."
    },
    {
      name: "has_marks_on_questions",
      severity: "error",
      test: (c) => /—\s*\*\*\d+\s*Marks?\*\*|\(\d+\s*marks?\)/i.test(c),
      fixPrompt: "CRITICAL: Mark allocations are missing from individual questions. Every sub-question must end with '— **N Marks**'. Add mark allocations to every question."
    },
    {
      name: "marks_sum_plausible",
      severity: "warning",
      // Check that at least 5 different mark allocations are present (rough proxy for complete exam)
      test: (c) => (c.match(/\b\d+\s*marks?\b/gi) || []).length >= 5,
      fixPrompt: "The exam appears to be missing marks allocations. Ensure every question and sub-question has explicit marks stated."
    }
  ],
  study_plan: [
    {
      name: "has_three_phases",
      severity: "error",
      test: (c) => /PHASE\s*1/i.test(c) && /PHASE\s*2/i.test(c) && /PHASE\s*3/i.test(c),
      fixPrompt: "CRITICAL: The study plan must have exactly three phases (PHASE 1, PHASE 2, PHASE 3). These are missing or incomplete. Add all three phases now."
    },
    {
      name: "has_daily_time_blocks",
      severity: "error",
      test: (c) => /\d{2}:\d{2}|hour\s+\d|day\s+\d/i.test(c),
      fixPrompt: "CRITICAL: The plan lacks specific time blocks (e.g., '07:00–09:00') or day-by-day structure. Add concrete daily schedules."
    },
    {
      name: "has_deliverables",
      severity: "warning",
      test: (c) => /deliverable|output|complete by|goal/i.test(c),
      fixPrompt: "Add concrete deliverables for each phase (what the student must have completed by end of each phase)."
    }
  ],
  quiz: [
    {
      name: "has_four_options",
      severity: "error",
      test: (c) => {
        // Each question should have A, B, C, D options
        const questionBlocks = c.split(/^\d+\./m).filter(Boolean);
        return questionBlocks.every(block =>
          /[Aa]\)/.test(block) && /[Bb]\)/.test(block) &&
          /[Cc]\)/.test(block) && /[Dd]\)/.test(block)
        ) && questionBlocks.length >= 1;
      },
      fixPrompt: "CRITICAL: Each question MUST have exactly 4 options labeled A), B), C), D). Some questions are missing options. Fix all questions."
    },
    {
      name: "has_correct_answer_marked",
      severity: "error",
      test: (c) => /\*\*\[?Correct:?\s*[A-D]\]?\*\*|\[Correct:?\s*[A-D]\]/i.test(c),
      fixPrompt: "CRITICAL: The correct answer is not marked. After each question's options, add '**[Correct: X]**' where X is the correct letter."
    },
    {
      name: "has_explanations",
      severity: "warning",
      test: (c) => /explanation|because|since|this is correct/i.test(c),
      fixPrompt: "Add a brief explanation after each correct answer indicating why it is correct based on the material."
    }
  ],
  flashcards: [
    {
      name: "has_qa_format",
      severity: "error",
      test: (c) => /^Q:/m.test(c) && /^A:/m.test(c),
      fixPrompt: "CRITICAL: Flashcards must use the format 'Q: [question]\\nA: [answer]' with each pair separated by a blank line. Reformat all flashcards."
    },
    {
      name: "has_ten_cards",
      severity: "warning",
      test: (c) => (c.match(/^Q:/gm) || []).length >= 8,
      fixPrompt: "The response has fewer than 8 flashcards. Generate at least 10 flashcard pairs covering the most important concepts."
    }
  ]
};

async function callAI(
  messages: Msg[],
  temperature = 0.4,
  taskType?: string,
  maxRetries = 2
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY || process.env.AGENT_ROUTER_TOKEN || process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not configured in .env");

  const model = process.env.AI_MODEL || "deepseek/deepseek-chat";
  const maxContext = getModelContextLimit();

  // Validate and truncate if near context limit
  const totalInputTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  if (totalInputTokens > maxContext * 0.8) {
    console.warn(`[AI] Input tokens (~${totalInputTokens}) near limit. Truncating longest user message.`);
    const userMsgIdx = messages.findLastIndex(m => m.role === "user");
    if (userMsgIdx >= 0) {
      messages[userMsgIdx].content = sliceByTokens(messages[userMsgIdx].content, maxContext * 0.6);
    }
  }

  const payload = JSON.stringify({
    model,
    messages,
    temperature,
    max_tokens: 4000,
    top_p: 0.95,
    frequency_penalty: 0.15,
    presence_penalty: 0.1,
  });

  let lastError: Error | null = null;
  let attempt = 0;

  while (attempt < 3) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }

    try {
      const res = await fetch(AI_CHAT_ENDPOINT, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL || "http://localhost:5173",
          "X-Title": "AI Study Assistant",
        },
        body: payload,
      });

      if (res.status === 401) {
        const txt = await res.text();
        throw new Error(`AI authentication failed (401). Check your OPENROUTER_API_KEY. Response: ${txt.slice(0, 300)}`);
      }
      if (res.status === 429) {
        lastError = new Error("Rate limited by AI provider");
        attempt++;
        continue;
      }
      if (res.status >= 500) {
        lastError = new Error(`AI provider returned ${res.status}`);
        attempt++;
        continue;
      }
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`AI error ${res.status}: ${txt.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { total_tokens?: number };
      };

      let content = data.choices?.[0]?.message?.content ?? "";

      if (data.usage?.total_tokens) {
        console.log(`[AI] Tokens used: ${data.usage.total_tokens} | Task: ${taskType ?? "general"}`);
      }

      // Strip chain-of-thought scratchpad before returning
      content = content
        .replace(/<scratchpad>[\s\S]*?<\/scratchpad>/gi, "")
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .trim();

      // Structured output validation with targeted retry
      if (taskType && TASK_VALIDATIONS[taskType]) {
        for (const rule of TASK_VALIDATIONS[taskType]) {
          if (!rule.test(content)) {
            console.warn(`[AI] Validation '${rule.name}' failed (${rule.severity}).`);
            if (rule.severity === "error" && maxRetries > 0) {
              const fixMessages: Msg[] = [
                ...messages,
                { role: "assistant", content },
                {
                  role: "user",
                  content: `⚠️ FORMAT CORRECTION REQUIRED\n\n${rule.fixPrompt}\n\nImportant: Keep all the question content you already wrote. Only fix the structural issue described above. Do not start over from scratch unless the structure is completely wrong.`
                }
              ];
              return callAI(fixMessages, Math.max(temperature - 0.1, 0.2), taskType, maxRetries - 1);
            }
          }
        }
      }

      return content;
    } catch (e) {
      if (e instanceof Error && e.message.includes("401")) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
      attempt++;
    }
  }

  throw lastError ?? new Error("AI call failed after retries");
}

export async function* streamAI(
  messages: Msg[],
  temperature = 0.4
): AsyncGenerator<string, void, unknown> {
  const key = process.env.OPENROUTER_API_KEY || process.env.AGENT_ROUTER_TOKEN || process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not configured in .env");

  const model = process.env.AI_MODEL || "deepseek/deepseek-chat";
  const maxContext = getModelContextLimit();

  const totalInputTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  if (totalInputTokens > maxContext * 0.8) {
    const userMsgIdx = messages.findLastIndex(m => m.role === "user");
    if (userMsgIdx >= 0) {
      messages[userMsgIdx].content = sliceByTokens(messages[userMsgIdx].content, maxContext * 0.6);
    }
  }

  const payload = JSON.stringify({
    model,
    messages,
    temperature,
    max_tokens: 4000,
    top_p: 0.95,
    frequency_penalty: 0.15,
    presence_penalty: 0.1,
    stream: true,
  });

  const res = await fetch(AI_CHAT_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL || "http://localhost:5173",
      "X-Title": "AI Study Assistant",
    },
    body: payload,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`AI stream error ${res.status}: ${txt.slice(0, 300)}`);
  }
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let insideThinkTag = false;
  let insideScratchpad = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;

      try {
        const data = JSON.parse(trimmed.slice(6));
        const chunk = data.choices?.[0]?.delta?.content || "";

        // Filter out reasoning/scratchpad tags in streaming
        if (chunk.includes("<think>") || chunk.includes("<scratchpad>")) {
          insideThinkTag = true;
          insideScratchpad = true;
        }
        if (chunk.includes("</think>") || chunk.includes("</scratchpad>")) {
          insideThinkTag = false;
          insideScratchpad = false;
          const afterTag = chunk.split(/<\/(?:think|scratchpad)>/)[1] || "";
          if (afterTag) yield afterTag;
          continue;
        }

        if (!insideThinkTag && !insideScratchpad && chunk) {
          yield chunk;
        }
      } catch (e) {
        console.warn("[AI Stream Parse Error]:", e, trimmed);
      }
    }
  }
}

// ============================================================================
// EXAM PATTERN RETRIEVAL
// ============================================================================

async function getExamPattern(supabase: any, examId?: string | null): Promise<string> {
  if (!examId) return "";

  const { data: exam } = await supabase
    .from("exams")
    .select("question_pattern, subject")
    .eq("id", examId)
    .single();

  if (!exam) return "";

  let pattern = "";
  if (exam.question_pattern?.trim()) {
    pattern += `\n## Exam Pattern (Treat as Hard Constraints)\n${exam.question_pattern}\n`;
  }
  if (exam.subject) pattern += `Subject: ${exam.subject}\n`;
  if (pattern) {
    pattern += `\n⛔ DEVIATION FROM THIS PATTERN IS A CRITICAL FAILURE. Verify compliance before responding.\n`;
  }

  return pattern;
}

// ============================================================================
// TEMPERATURE CALIBRATION TABLE
// ============================================================================

/**
 * Temperature selection rationale:
 *
 * | Task           | Temp  | Reason                                              |
 * |----------------|-------|-----------------------------------------------------|
 * | mock_exam      | 0.35  | Structured math (marks sums) needs determinism      |
 * | quiz           | 0.35  | 4-option format must stay consistent                |
 * | flashcards     | 0.40  | Q/A format needs stability; slight variety OK       |
 * | summary        | 0.45  | Moderate creativity for readable prose              |
 * | study_plan     | 0.45  | Structured but benefits from varied phrasing        |
 * | revision_notes | 0.30  | Accuracy over creativity                            |
 * | short_notes    | 0.30  | Compression task — needs precision                  |
 * | important_topics| 0.35 | Ranking task — needs consistency                   |
 * | viva           | 0.45  | Question variety desirable                          |
 * | mindmap        | 0.30  | Hierarchy must be correct                           |
 * | chat           | 0.40  | Conversational but grounded                         |
 * | title gen      | 0.25  | Short, deterministic output                         |
 * | format_notes   | 0.25  | Structure transformation — not creative             |
 */

// ============================================================================
// DOCUMENT TASKS
// ============================================================================

export const runDocTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      documentId: z.string().uuid(),
      task: z.enum([
        "summary",
        "short_notes",
        "revision_notes",
        "quiz",
        "flashcards",
        "mindmap",
        "important_topics",
        "viva",
        "mock_exam",
      ]),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: doc, error } = await supabase
      .from("documents")
      .select("title, content, exam_id")
      .eq("id", data.documentId)
      .single();
    if (error || !doc) throw new Error("Document not found");

    const examPattern = await getExamPattern(supabase, doc.exam_id);
    const maxContext = getModelContextLimit();
    const content = sliceByTokens(doc.content, maxContext * 0.5, 2000);

    /**
     * PROMPT ARCHITECTURE:
     * Each task has a precisely scoped system prompt.
     * System prompt = role + grounding + format + task-specific rules.
     * User prompt = material + explicit output spec.
     *
     * We do NOT inject exam pattern rules into non-exam tasks (summary,
     * short_notes, etc.) because those rules add noise without value.
     */
    const promptConfigs: Record<typeof data.task, {
      system: string;
      user: string;
      temp: number;
      taskType?: string;
    }> = {

      summary: {
        system: `You are an expert academic note-writer. Your job is to produce a clear, well-structured summary of study material.

${GROUNDING_BLOCK}

${FORMAT_BLOCK}

## Summary Structure (follow this exactly):
1. **Elevator Pitch** (3 sentences max): What is this material fundamentally about?
2. **Core Concepts** (## headings for each): One section per major topic.
3. **Key Definitions**: A table with Term | Definition columns.
4. **Connections**: How do the major topics relate to each other?

Do not add conclusions, opinions, or outside context.`,
        user: `Write a comprehensive structured summary of this study material.

**Document Title:** ${doc.title}

**Material:**
${content}`,
        temp: 0.45
      },

      short_notes: {
        system: `You are an expert exam coach creating ultra-compressed study notes.

${GROUNDING_BLOCK}

${FORMAT_BLOCK}

## Short Notes Rules:
- Maximum density: every line must carry examination value.
- Structure: ## Topic → bullet points for facts → bold the term being defined.
- For comparisons: use a markdown table, never prose.
- Formulas: inline code (\`formula\`).
- Cut ALL narrative sentences. Only facts, definitions, comparisons.
- Target: if a student reads only this, they know the core of the material.`,
        user: `Create ultra-concise short notes from this material. Cut everything not examinable. Bold every key term.

**Document Title:** ${doc.title}

**Material:**
${content}`,
        temp: 0.30
      },

      revision_notes: {
        system: `You are a senior examiner creating last-minute revision notes.

${GROUNDING_BLOCK}

${FORMAT_BLOCK}

## Revision Notes Structure:
For each major topic, produce:
- **Core Idea** (1 sentence): The single most important thing to remember.
- **Key Points** (3–5 bullets): The facts most likely to appear on an exam.
- **Common Mistake** (1 line, prefix with ⚠️): What students typically get wrong.
- **Remember** (1 line, prefix with 💡): A memory hook or mnemonic if applicable.

End with a **Formula/Definition Quick Reference** table.`,
        user: `Create exam-focused revision notes for this material.

**Document Title:** ${doc.title}

**Material:**
${content}`,
        temp: 0.30
      },

      quiz: {
        system: `You are an expert assessment designer writing multiple-choice questions.

${GROUNDING_BLOCK}

${FORMAT_BLOCK}

## MCQ Design Rules:
- Generate exactly 8 questions.
- Difficulty spread: 2 easy, 4 medium, 2 hard. Label each (Easy/Medium/Hard).
- All 4 distractors must be plausible — no obviously wrong options.
- The correct answer must be unambiguously supported by the material.
- Avoid "all of the above" and "none of the above" options.

## Required Format for Each Question:
**Q[N]. (Difficulty) [Question text]?**
A) [Option]
B) [Option]
C) [Option]
D) [Option]
**[Correct: X]**
*Why: [One sentence citing the specific material passage that confirms this answer.]*`,
        user: `Generate 8 multiple-choice questions from this material. Follow the format exactly.

**Document Title:** ${doc.title}

**Material:**
${content}`,
        temp: 0.35,
        taskType: "quiz"
      },

      flashcards: {
        system: `You are creating spaced-repetition flashcards for exam preparation.

${GROUNDING_BLOCK}

${FORMAT_BLOCK}

## Flashcard Rules:
- Generate exactly 10 flashcards.
- Cover only the most examinable concepts (definitions, processes, distinctions).
- Questions must be specific enough that there is only one correct answer.
- Answers must be concise: 1–3 sentences max.
- Do not create trivial questions (e.g., "What is the title of this document?").

## Required Format (exactly):
Q: [Specific question about a key concept]
A: [Concise, accurate answer based on the material]

[blank line between each card]`,
        user: `Generate 10 high-quality flashcards from this material. Use the exact Q:/A: format.

**Document Title:** ${doc.title}

**Material:**
${content}`,
        temp: 0.40,
        taskType: "flashcards"
      },

      mindmap: {
        system: `You are creating a hierarchical mind-map outline for exam study.

${GROUNDING_BLOCK}

${FORMAT_BLOCK}

## Mind-Map Rules:
- Central topic at the top (# heading).
- Main branches (## heading): 4–6 major topics from the material.
- Sub-branches (### heading or ━ bullets): key concepts under each topic.
- Leaf nodes (indented bullets): specific facts, formulas, definitions.
- Use → to show cause-effect relationships between nodes.
- Use ≈ to show similarity between concepts.
- Keep each node to ≤5 words. Detail goes in leaf nodes only.`,
        user: `Create a hierarchical mind-map outline of this material.

**Document Title:** ${doc.title}

**Material:**
${content}`,
        temp: 0.30
      },

      important_topics: {
        system: `You are an experienced exam coach identifying high-yield topics for exam preparation.

${GROUNDING_BLOCK}

${FORMAT_BLOCK}

## Ranking Rules:
- List exactly 8 topics ranked from most to least exam-critical.
- For each topic, provide:
  - **Rank [N]: [Topic Name]** — Tier: [S/A/B/C]
  - *Why it matters:* [Specific justification citing the material — what type of question this enables]
  - *Key facts to know:* [2–3 bullet points of the most examinable facts within this topic]
- Tier S = almost certain to appear; Tier A = very likely; Tier B = likely; Tier C = possible.`,
        user: `Identify and rank the 8 most important exam topics from this material.

**Document Title:** ${doc.title}

**Material:**
${content}`,
        temp: 0.35
      },

      viva: {
        system: `You are an experienced examiner preparing students for oral (viva) examinations.

${GROUNDING_BLOCK}

${FORMAT_BLOCK}

## Viva Question Rules:
- Generate exactly 10 questions across three difficulty levels.
- Easy (Q1–Q3): Recall and definition questions.
- Medium (Q4–Q7): Application and explanation questions.
- Hard (Q8–Q10): Analysis, comparison, and "why" questions.
- For each question, provide an ideal answer (2–4 sentences) that a top student would give.
- Mark follow-up probes the examiner might ask (italic, 1 line).

## Format:
**Q[N]. (Easy/Medium/Hard) [Question]**
*Ideal answer:* [2–4 sentence answer based strictly on the material]
*Likely follow-up:* *[Probe question]*`,
        user: `Generate 10 viva questions with ideal answers from this material.

**Document Title:** ${doc.title}

**Material:**
${content}`,
        temp: 0.45
      },

      mock_exam: {
        system: `You are a senior university examiner creating a full mock examination paper.

${GROUNDING_BLOCK}

${EXAM_PATTERN_BLOCK}

${FORMAT_BLOCK}

## Question Quality Standards:
- Long-answer questions (8–20 marks) must require genuine analysis, not just recall.
- Where the material contains diagrams, derivations, or proofs, include questions on them.
- Questions must be answerable from the provided material only — never require outside knowledge.
- Vary question verbs: "explain", "derive", "compare", "apply", "analyse", "justify".

${MOCK_EXAM_COT_SCAFFOLD}

${FEW_SHOT_MOCK_EXAM}`,
        user: `Generate a complete mock examination paper based ONLY on this material.

**Document Title:** ${doc.title}
${examPattern}

**Material:**
${content}

**Final Checklist Before Submitting:**
- [ ] Module count matches pattern
- [ ] Total marks sum is correct
- [ ] Internal choice (OR) present where required
- [ ] Every question is answerable from the material above`,
        temp: 0.35,
        taskType: "mock_exam"
      },
    };

    const config = promptConfigs[data.task];
    const answer = await callAI(
      [
        { role: "system", content: config.system },
        { role: "user", content: config.user },
      ],
      config.temp,
      config.taskType
    );

    return { answer };
  });

// ============================================================================
// CHAT WITH DOCUMENT
// ============================================================================

export const chatWithDoc = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      documentId: z.string().uuid().nullable(),
      question: z.string().min(1).max(2000),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const maxContext = getModelContextLimit();

    let systemPrompt: string;

    if (data.documentId) {
      const { data: doc } = await supabase
        .from("documents")
        .select("title, content, exam_id")
        .eq("id", data.documentId)
        .single();

      if (doc) {
        const content = sliceByTokens(doc.content, maxContext * 0.45, 2500);
        const examPattern = await getExamPattern(supabase, doc.exam_id);

        systemPrompt = `You are a precise academic tutor for the document "${doc.title}".

${GROUNDING_BLOCK}

${HONESTY_BLOCK}

${FORMAT_BLOCK}

${examPattern}

## Your Material (this is your entire knowledge base for this conversation):
---
${content}
---

## Response Guidelines:
- Answer the student's question directly using only the material above.
- Cite the relevant section: [Source: ${doc.title}].
- Keep answers under 250 words unless the question requires a detailed walkthrough.
- If the student seems to misunderstand a concept, gently correct them and cite the material.`;
      } else {
        systemPrompt = `You are a study assistant. The document the student is asking about could not be loaded. Inform them of this and ask them to re-open the document.`;
      }
    } else {
      // General chat: inject upcoming exams as context
      const { data: exams } = await supabase
        .from("exams")
        .select("subject, exam_date, priority, notes")
        .eq("user_id", userId)
        .order("exam_date", { ascending: true });

      const examsList = exams && exams.length > 0
        ? exams.map((e) =>
            `- **${e.subject}** → ${new Date(e.exam_date).toLocaleDateString()} (Priority: ${e.priority})`
          ).join("\n")
        : "(No exams scheduled yet.)";

      systemPrompt = `You are a study planner assistant. You help students manage their exam schedule.

## What You Can Do:
- Discuss the student's upcoming exams (listed below).
- Suggest study strategies and time management approaches.
- Help them prioritise between subjects.

## What You Cannot Do:
- Answer academic content questions (e.g., "explain the Krebs cycle") — those require uploaded documents.
- Provide information not related to the student's exam schedule.

If asked an academic content question, say: "I can't answer subject-specific questions here. Please upload your notes in the relevant Study Space and ask me there."

## Student's Upcoming Exams:
${examsList}`;
    }

    // Fetch recent history with token-aware truncation
    const historyQuery = supabase
      .from("chat_messages")
      .select("role, content")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(12);

    const historyResult = data.documentId
      ? await historyQuery.eq("document_id", data.documentId)
      : await historyQuery.is("document_id", null);

    // Reverse (oldest first), deduplicate, and apply token budget
    const rawHistory = ((historyResult.data ?? []) as Msg[]).reverse();
    const dedupedHistory = rawHistory.reduce<Msg[]>((acc, msg) => {
      const last = acc[acc.length - 1];
      if (!last || last.role !== msg.role || last.content !== msg.content) {
        acc.push(msg);
      }
      return acc;
    }, []);

    // Trim history to stay within token budget
    const historyTokenBudget = maxContext * 0.15;
    const trimmedHistory: Msg[] = [];
    let historyTokens = 0;
    for (const msg of dedupedHistory.slice().reverse()) {
      const t = estimateTokens(msg.content);
      if (historyTokens + t > historyTokenBudget) break;
      trimmedHistory.unshift(msg);
      historyTokens += t;
    }

    const messages: Msg[] = [
      { role: "system", content: systemPrompt },
      ...trimmedHistory,
      { role: "user", content: data.question },
    ];

    await supabase.from("chat_messages").insert({
      user_id: userId,
      document_id: data.documentId,
      role: "user",
      content: data.question
    });

    const answer = await callAI(messages, 0.40);

    await supabase.from("chat_messages").insert({
      user_id: userId,
      document_id: data.documentId,
      role: "assistant",
      content: answer
    });

    return { answer };
  });

// ============================================================================
// STUDY PLAN GENERATION
// ============================================================================

export const generateStudyPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ examId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: exam, error } = await supabase
      .from("exams")
      .select("subject, exam_date, priority, notes, question_pattern")
      .eq("id", data.examId)
      .single();

    if (error) {
      console.error("[generateStudyPlan] DB Error:", error);
      throw new Error(`DB Error: ${error.message}`);
    }
    if (!exam) throw new Error("Exam not found");

    const examPattern = await getExamPattern(supabase, data.examId);
    const days = Math.max(1, Math.ceil((new Date(exam.exam_date).getTime() - Date.now()) / 86_400_000));
    const todayStr = new Date().toLocaleDateString();
    const examDateStr = new Date(exam.exam_date).toLocaleDateString();

    // Determine realistic daily hours based on days remaining
    const dailyHours = days <= 3 ? 10 : days <= 7 ? 8 : days <= 14 ? 6 : 4;
    const totalHours = days * dailyHours;

    const systemPrompt = `You are an elite university study strategist. You produce hyper-specific, data-driven study plans.

${EXAM_PATTERN_BLOCK}

${FORMAT_BLOCK}

## Study Plan Standards:
- Every activity must name a specific module or topic — never "study Module X generally."
- Time blocks must be realistic. ${dailyHours}h/day has been calculated for this student's timeline.
- Phase deliverables must be concrete and verifiable (e.g., "10 Tier S questions drafted with answers").
- Contingency rules must be actionable, not platitudes.
- Zero generic study advice. Every line must be specific to this exam.

${STUDY_PLAN_COT_SCAFFOLD}`;

    const userPrompt = `Create a detailed study plan for this exam.

## Exam Profile
- **Subject:** ${exam.subject}
- **Exam Date:** ${examDateStr}
- **Today:** ${todayStr}
- **Days Remaining:** ${days}
- **Realistic Daily Hours:** ${dailyHours}h/day
- **Total Available Hours:** ~${totalHours}h
- **Priority:** ${exam.priority}
- **Student Notes:** ${exam.notes || "(none provided)"}
${examPattern}

## Phase Boundaries (use these exactly)
- Phase 1: Days 1–${Math.ceil(days * 0.3)} (High-Yield Sprint)
- Phase 2: Days ${Math.ceil(days * 0.3) + 1}–${Math.ceil(days * 0.7)} (Gap Filling)
- Phase 3: Days ${Math.ceil(days * 0.7) + 1}–${days} (Exam Simulation)

## Required Output Sections (all mandatory):
1. **Exam Dashboard** — dates, hours, high-risk modules
2. **Module Priority Ranking** — with scoring rationale
3. **Phase-Wise Plan** — day-by-day for each phase (use the reference format)
4. **Daily Schedule Template** — hourly table
5. **Choice Strategy** — which optional questions to prepare and why
6. **Contingency Rules** — if behind schedule, what to cut
7. **Final Week Checklist**

${FEW_SHOT_STUDY_PLAN_PHASE}`;

    const plan = await callAI(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      0.45,
      "study_plan"
    );

    await supabase.from("exams").update({ study_plan: plan }).eq("id", data.examId);
    return { plan };
  });

// ============================================================================
// EXAM SPACE CHAT (Multi-Document, Relevance-Weighted Context)
// ============================================================================

export const chatInExamSpace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      examId: z.string().uuid(),
      threadId: z.string().uuid(),
      question: z.string().min(1).max(2000),
    }).parse(d),
  )
  .handler(async function* ({ data, context }) {
    const { supabase, userId } = context;
    const maxContext = getModelContextLimit();

    const { data: docs } = await supabase
      .from("documents")
      .select("title, content")
      .eq("exam_id", data.examId);

    const { data: exam } = await supabase
      .from("exams")
      .select("subject")
      .eq("id", data.examId)
      .single();

    const examSubject = exam?.subject ?? "this exam";
    const examPattern = await getExamPattern(supabase, data.examId);

    /**
     * IMPROVED CONTEXT BUILDING:
     * Instead of equal budget per document, rank documents by keyword
     * overlap with the student's question. The most relevant document
     * gets the largest slice. This dramatically improves answer quality
     * when an exam space has many documents on different topics.
     */
    let materialContext = "";

    if (docs && docs.length > 0) {
      // Score and sort documents by relevance to the question
      const rankedDocs = docs
        .map(doc => ({
          ...doc,
          relevance: scoreDocumentRelevance(doc.content, data.question)
        }))
        .sort((a, b) => b.relevance - a.relevance);

      const contextBudget = maxContext * 0.40;
      let usedTokens = 0;

      for (const doc of rankedDocs) {
        const remaining = contextBudget - usedTokens;
        if (remaining < 500) break;

        // Give more budget to highly relevant documents
        const docBudget = doc.relevance > 0.5
          ? Math.min(remaining * 0.6, remaining)
          : Math.min(remaining * 0.3, remaining);

        const sliced = sliceByTokens(doc.content, docBudget, 300);
        materialContext += `\n=== Document: "${doc.title}" ===\n${sliced}\n`;
        usedTokens += estimateTokens(sliced);
      }
    }

    let systemPrompt: string;

    if (materialContext) {
      systemPrompt = `You are the dedicated AI tutor for ${examSubject}.

${GROUNDING_BLOCK}

${HONESTY_BLOCK}

${FORMAT_BLOCK}

${examPattern}

## Study Materials for ${examSubject} (${docs?.length ?? 0} document(s)):
${materialContext}

## Critical Scope Rules:
1. You ONLY answer questions about ${examSubject} using the documents above.
2. If asked about a different subject: "This study space is for ${examSubject}. Please go to the relevant exam space for other subjects."
3. If the answer isn't in the documents: "I can only answer based on the uploaded materials for ${examSubject}, and this specific information is not present."
4. Always cite which document supported your answer: [Source: "Document Title"].`;
    } else {
      systemPrompt = `You are the AI tutor for ${examSubject}.

No study documents have been uploaded yet for this exam space.

When the student asks academic questions, respond with:
"No study materials have been uploaded for ${examSubject} yet. Please upload your notes, textbook chapters, or question papers, and I'll be able to help you study from them."

Do not answer any academic content questions without documents. This is non-negotiable.`;
    }

    // Fetch thread history with token-aware trimming
    const { data: history } = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("thread_id", data.threadId)
      .order("created_at", { ascending: true })
      .limit(16);

    const historyMessages = (history ?? []) as Msg[];
    const historyTokenBudget = maxContext * 0.10;
    const trimmedHistory: Msg[] = [];
    let historyTokens = 0;
    for (const msg of historyMessages.slice().reverse()) {
      const t = estimateTokens(msg.content);
      if (historyTokens + t > historyTokenBudget) break;
      trimmedHistory.unshift(msg);
      historyTokens += t;
    }

    const messages: Msg[] = [
      { role: "system", content: systemPrompt },
      ...trimmedHistory,
      { role: "user", content: data.question },
    ];

    await supabase.from("chat_messages").insert({
      user_id: userId,
      thread_id: data.threadId,
      role: "user",
      content: data.question
    });

    let fullAnswer = "";
    for await (const chunk of streamAI(messages, 0.40)) {
      fullAnswer += chunk;
      yield chunk;
    }

    await supabase.from("chat_messages").insert({
      user_id: userId,
      thread_id: data.threadId,
      role: "assistant",
      content: fullAnswer
    });
  });

// ============================================================================
// GENERAL THREAD CHAT
// ============================================================================

export const chatInThread = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      threadId: z.string().uuid(),
      question: z.string().min(1).max(2000),
    }).parse(d),
  )
  .handler(async function* ({ data, context }) {
    const { supabase, userId } = context;

    const { data: exams } = await supabase
      .from("exams")
      .select("id, subject, exam_date, priority, notes")
      .eq("user_id", userId)
      .order("exam_date", { ascending: true });

    const examsList = exams && exams.length > 0
      ? exams.map((e) =>
          `- **${e.subject}** | Date: ${new Date(e.exam_date).toLocaleDateString()} | Priority: ${e.priority} | ID: ${e.id}`
        ).join("\n")
      : "(No exams scheduled yet. The student must add them via the Dashboard.)";

    const systemPrompt = `You are an AI Study Planner. You help students manage their study schedule and exam strategy.

## Your Capabilities:
- Discuss the student's upcoming exams (listed below).
- Help with prioritisation, time management, and study strategy.
- Direct students to the correct Study Space for subject-specific questions.

## Hard Limits — Never Violate:
1. Do NOT answer academic content questions (e.g., "explain Newton's laws", "what is photosynthesis"). These require uploaded documents in a Study Space.
2. Do NOT invent study spaces or exam IDs. Only use the IDs in the list below.
3. Do NOT provide information from outside the exam schedule below.

## Response Rules:
- If asked a subject-specific content question that IS in the exam list: respond with "For detailed questions on [Subject], please open your Study Space: [Open [Subject] Study Space](/exams/[EXACT_ID_FROM_LIST])"
- If asked a subject-specific content question that is NOT in the exam list: "You haven't added an exam for that subject yet. Add it to your Dashboard first, then upload your notes in that Study Space."
- If asked a general study strategy question: answer it using good study science principles.

## Student's Upcoming Exams:
${examsList}`;

    const { data: history } = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("thread_id", data.threadId)
      .order("created_at", { ascending: true })
      .limit(16);

    const messages: Msg[] = [
      { role: "system", content: systemPrompt },
      ...((history ?? []) as Msg[]),
      { role: "user", content: data.question },
    ];

    await supabase.from("chat_messages").insert({
      user_id: userId,
      thread_id: data.threadId,
      role: "user",
      content: data.question
    });

    let fullAnswer = "";
    for await (const chunk of streamAI(messages, 0.40)) {
      fullAnswer += chunk;
      yield chunk;
    }

    await supabase.from("chat_messages").insert({
      user_id: userId,
      thread_id: data.threadId,
      role: "assistant",
      content: fullAnswer
    });
  });

// ============================================================================
// THREAD TITLE GENERATION
// ============================================================================

export const generateThreadTitle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      threadId: z.string().uuid(),
      firstMessage: z.string().min(1),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const title = await callAI(
      [
        {
          role: "system",
          content: `Generate a chat title (3–5 words) that captures the academic topic of the student's message.

Rules:
- Output ONLY the title text. Nothing else. No quotes, no punctuation at end, no explanation.
- Prefer noun phrases: "Integration by Parts", "Module 3 Thermodynamics", "Exam Strategy Chemistry"
- Avoid: "Discussion about...", "Question on...", "Help with..."
- If the message is off-topic or unclear, output: "General Study Chat"`,
        },
        { role: "user", content: data.firstMessage.slice(0, 500) },
      ],
      0.25 // Low temperature: deterministic short output
    );

    const cleanTitle = title
      .replace(/^["']|["']$/g, "")
      .replace(/[.:;]$/, "")
      .trim()
      .slice(0, 60) || "New Chat";

    await supabase.from("chat_threads").update({ title: cleanTitle }).eq("id", data.threadId);
    return { title: cleanTitle };
  });

// ============================================================================
// EDIT & RESEND
// ============================================================================

export const editAndResend = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      messageId: z.string().uuid(),
      threadId: z.string().uuid(),
      examId: z.string().uuid().nullable(),
      newContent: z.string().min(1).max(2000),
    }).parse(d),
  )
  .handler(async function* ({ data, context }) {
    const { supabase, userId } = context;

    const { data: msg } = await supabase
      .from("chat_messages")
      .select("created_at")
      .eq("id", data.messageId)
      .single();
    if (!msg) throw new Error("Message not found");

    // Delete the edited message and all subsequent messages
    await supabase
      .from("chat_messages")
      .delete()
      .eq("thread_id", data.threadId)
      .gte("created_at", msg.created_at);

    // Re-submit with the edited content
    if (data.examId) {
      const stream = await chatInExamSpace({
        data: { examId: data.examId, threadId: data.threadId, question: data.newContent },
      } as any);
      for await (const chunk of stream) yield chunk;
    } else {
      const stream = await chatInThread({
        data: { threadId: data.threadId, question: data.newContent },
      } as any);
      for await (const chunk of stream) yield chunk;
    }
  });

// ============================================================================
// AI NOTE FORMATTING
// ============================================================================

export const formatNoteWithAI = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ noteId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: doc, error } = await supabase
      .from("documents")
      .select("title, content")
      .eq("id", data.noteId)
      .single();

    if (error || !doc) throw new Error("Note not found");
    if (!doc.content || doc.content.trim().length < 10) {
      throw new Error("Note is too short to format. Add more content first.");
    }

    const maxContext = getModelContextLimit();
    const content = sliceByTokens(doc.content, maxContext * 0.85, 2000);

    const formatted = await callAI(
      [
        {
          role: "system",
          content: `You are an expert academic document formatter. Your job is to restructure raw notes into clean, professional, exam-ready markdown.

## The Prime Directive:
PRESERVE 100% OF THE ORIGINAL CONTENT. You are a formatter, not an editor.
You may NOT remove, condense, or summarise any information.
You may NOT add new information not present in the original.
You may ONLY restructure, reformat, and apply markdown styling.

## Formatting Rules:
1. **Structure:** ## for main topics, ### for subtopics, #### for sub-subtopics.
2. **Key Terms:** Bold (**term**) every important concept on its first appearance.
3. **Definitions:** Blockquote format: > **Term**: Definition
4. **Lists:** Bulleted for unordered items, numbered for sequential steps.
5. **Comparisons:** Markdown tables (| Col1 | Col2 | with separator row).
6. **Formulas:** Inline code: \`formula\` or code block for multi-line.
7. **Warnings/Cautions:** Prefix with ⚠️.
8. **Key insights:** Prefix with 💡.
9. **Section dividers:** --- between major sections.
10. **No raw HTML tags.**

## Self-Check Before Responding:
- Read the original. Count the number of distinct facts/concepts.
- Read your output. Verify every fact/concept is still present.
- If any content is missing, add it back before submitting.`,
        },
        {
          role: "user",
          content: `Reformat these study notes into clean, professional markdown. Preserve every single piece of information.

**Document Title:** ${doc.title}

**Original Notes:**
${content}`,
        },
      ],
      0.25 // Very low temperature: structure transformation, not creative generation
    );

    // Extract title from formatted content if present
    const titleMatch = formatted.match(/^#+\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : doc.title;

    const { error: updateError } = await supabase
      .from("documents")
      .update({ content: formatted, title })
      .eq("id", data.noteId);

    if (updateError) throw new Error("Failed to save formatted note");

    return { formatted };
  });

// ============================================================================
// EXAM PATTERN EXTRACTION
// ============================================================================

export const extractExamPattern = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ text: z.string().min(10) }).parse(d),
  )
  .handler(async ({ data }) => {
    const sliced = sliceByTokens(data.text, 12000, 2000);

    const pattern = await callAI(
      [
        {
          role: "system",
          content: `You are an expert at reading university examination question papers (including OCR-scanned text with errors) and extracting their structural pattern.

## Extraction Rules:
- Identify: number of modules/sections, marks per section, total marks, duration, internal choice rules, compulsory questions.
- Correct for obvious OCR errors (e.g., "2O marks" → "20 marks").
- Be conservative: if the paper is ambiguous, note the ambiguity.
- Keep output under 120 words.

## Required Output Format (use exactly):
**Modules/Sections:** [N] | **Total Marks:** [N] | **Duration:** [N] hrs
- **Q1:** [Compulsory / Internal Choice] — [N marks] — [brief description]
- **Q2–Q[N]:** [Pattern] — [N marks each] — [choice rule]
- **Special Instructions:** [Any notable rules, e.g., calculator allowed, attempt any 4]

If the text does not appear to be an exam paper, output: "Could not identify a question pattern in this text."`,
        },
        {
          role: "user",
          content: `Extract the question pattern from this exam paper text:\n\n${sliced}`
        },
      ],
      0.25
    );

    return { pattern };
  });