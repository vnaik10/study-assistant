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
  // More accurate than simple length/4 — accounts for whitespace, punctuation
  const clean = text.trim();
  if (!clean) return 0;
  // Weighted: code/math heavier, prose lighter
  const codeHeaviness = (clean.match(/[{}[\];=+\-*\/<>]/g) || []).length / clean.length;
  const ratio = 3.5 + codeHeaviness * 1.5; // 3.5 to 5.0 chars per token
  return Math.ceil(clean.length / ratio);
}

/** Smart slicer that respects paragraph boundaries and token limits */
function sliceByTokens(text: string, maxTokens: number, reserveOutput = 1500): string {
  const availableInput = maxTokens - reserveOutput - 500; // 500 for system prompt overhead
  if (estimateTokens(text) <= availableInput) return text;
  
  // Slice at paragraph boundaries, not mid-sentence
  const paragraphs = text.split(/\n\s*\n/);
  let result = "";
  let tokens = 0;
  
  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    if (tokens + paraTokens > availableInput) {
      // Try to add at least a clean sentence ending
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
  return 32000; // safe default for OpenRouter
}

// ============================================================================
// ENHANCED SYSTEM PROMPT TEMPLATES
// ============================================================================

const BASE_SYSTEM_CONSTRAINTS = `You are an elite academic AI tutor with strict operational constraints:

## ABSOLUTE RULES (Violating these is a critical failure):
1. GROUNDING: You MUST ONLY use the provided study materials. ZERO outside knowledge.
2. CITATIONS: When stating facts, append [Source: Document Name] or [Source: Material].
3. HONESTY: If information is not in the materials, say EXACTLY: "I can only answer based on the provided document, and this information is not present."
4. NO HALLUCINATION: Do not invent page numbers, authors, or details not explicitly in the text.
5. FORMAT: Always use clean, valid markdown. No raw HTML. Tables must have proper markdown syntax.
6. SELF-CORRECTION: Before finalizing, verify that every claim maps to specific text in the materials.`;

const EXAM_PATTERN_CONSTRAINTS = `## EXAM PATTERN COMPLIANCE:
- When generating mock exams or study plans, the exam pattern provided by the user is LAW.
- Module count, marks distribution, and internal choice structure MUST match exactly.
- If the pattern specifies "5 modules, 20 marks each, internal choice", your output MUST reflect this precisely.
- Double-check your generated exam structure against the pattern before responding.`;

const FEW_SHOT_MOCK_EXAM = `## EXAMPLE OF CORRECT MOCK EXAM FORMAT:
User Pattern: "5 modules, 20 marks each, Q1 compulsory, Q2-Q5 internal choice (attempt 4 out of 5)"

Your Output Must Be:
# Mock Exam: [Subject]

**Time:** 3 Hours | **Max Marks:** 100 | **Instructions:** Q1 compulsory. Attempt any four from Q2-Q5.

---

## Q1 (Compulsory) — 20 Marks
a) [Question from Module 1] — 4 Marks  
b) [Question from Module 2] — 4 Marks  
c) [Question from Module 3] — 4 Marks  
d) [Question from Module 4] — 4 Marks  
e) [Question from Module 5] — 4 Marks  

## Q2 (Module 1) — 20 Marks (Internal Choice: Attempt any two)
a) [Detailed question] — 10 Marks  
OR  
a\') [Alternative detailed question] — 10 Marks  
b) [Detailed question] — 10 Marks  
OR  
b\') [Alternative detailed question] — 10 Marks  

[Repeat for Q3-Q5 mapping to Modules 2-4, Q6 for Module 5]`;

const FEW_SHOT_STUDY_PLAN = `## EXAMPLE OF CORRECT STUDY PLAN PHASE:
### PHASE 1: High-Yield Sprint (Day 1 to Day [N])
**Goal:** Secure definite marks. Master Tier S questions.
- **Focus:** Module 3 (highest repeat rate) + Q5(a)/Q5(b) choice questions
- **Daily Structure:**
  - Hour 1-2: Solve 3 Tier S questions from Module 3 [Source: PYQ 2023, 2024]
  - Hour 3-4: Map Q5 section — identify which sub-question has higher repeat probability
  - Hour 5-6: Formula memorization + flashcard review
- **Deliverable:** Completed Tier S list for Module 3 with confidence ratings`;

// ============================================================================
// RESPONSE VALIDATION & RETRY LOGIC
// ============================================================================

type Msg = { role: "system" | "user" | "assistant"; content: string };

interface ValidationRule {
  name: string;
  test: (content: string) => boolean;
  fixPrompt: string;
}

/** Validation rules for structured outputs */
const TASK_VALIDATIONS: Record<string, ValidationRule[]> = {
  mock_exam: [
    {
      name: "has_module_structure",
      test: (c) => /module\s*\d|Q\d\s*\(.*?\d+\s*marks/i.test(c),
      fixPrompt: "Your previous response was missing the required module/question structure. Ensure the mock exam has clear Q1-Q6 structure with marks and internal choice indicators (OR / alternative questions)."
    },
    {
      name: "has_marks_distribution",
      test: (c) => /(20\s*marks|100\s*marks|\d+\s*Marks)/i.test(c),
      fixPrompt: "Add clear marks distribution. Each module should be 20 marks, total 100 marks."
    }
  ],
  study_plan: [
    {
      name: "has_phases",
      test: (c) => /phase\s*\d|phase\s*1/i.test(c),
      fixPrompt: "The study plan MUST have Phase 1, Phase 2, and Phase 3 blocks. Add these clearly."
    },
    {
      name: "has_daily_structure",
      test: (c) => /hour\s*\d|time\s*block|daily\s*structure/i.test(c),
      fixPrompt: "Include specific hourly time blocks in each phase (e.g., Hour 1-2, Hour 3-4)."
    }
  ],
  quiz: [
    {
      name: "has_options",
      test: (c) => /[A-D][).]\s|Option\s*[A-D]/i.test(c),
      fixPrompt: "Each question MUST have 4 options labeled A, B, C, D with the correct answer clearly marked."
    }
  ],
  flashcards: [
    {
      name: "has_qa_pairs",
      test: (c) => /Q:\s|Question:|A:\s|Answer:/i.test(c),
      fixPrompt: "Format each flashcard as 'Q: ... / A: ...' pairs."
    }
  ]
};

async function callDeepSeek(
  messages: Msg[],
  temperature = 0.4,
  taskType?: string,
  maxRetries = 2
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY || process.env.AGENT_ROUTER_TOKEN || process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not configured in .env");

  const model = process.env.AI_MODEL || "deepseek/deepseek-chat";
  const maxContext = getModelContextLimit();
  
  // Validate total prompt tokens won't exceed context
  const totalInputTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  if (totalInputTokens > maxContext * 0.8) {
    console.warn(`[AI] Input tokens (${totalInputTokens}) near limit. Truncating...`);
    // Truncate the longest user message
    const userMsgIdx = messages.findLastIndex(m => m.role === "user");
    if (userMsgIdx >= 0) {
      messages[userMsgIdx].content = sliceByTokens(messages[userMsgIdx].content, maxContext * 0.6);
    }
  }

  const payload = JSON.stringify({ 
    model, 
    messages, 
    temperature,
    max_tokens: 4000, // Reserve output space
    top_p: 0.95,
    frequency_penalty: 0.1, // Reduce repetition
    presence_penalty: 0.1   // Encourage coverage of all topics
  });

  let lastError: Error | null = null;
  let attempt = 0;
  
  while (attempt < 3) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt))); // exponential backoff
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
        choices?: { message?: { content?: string; reasoning?: string } }[];
        usage?: { total_tokens?: number };
      };
      
      let content = data.choices?.[0]?.message?.content ?? "";
      
      // Log token usage for monitoring
      if (data.usage?.total_tokens) {
        console.log(`[AI] Token usage: ${data.usage.total_tokens} for task ${taskType || "general"}`);
      }

      // Post-process: remove thinking tags if model outputs reasoning
      content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

      // Validate structured outputs
      if (taskType && TASK_VALIDATIONS[taskType]) {
        const validations = TASK_VALIDATIONS[taskType];
        for (const rule of validations) {
          if (!rule.test(content)) {
            console.warn(`[AI] Validation failed: ${rule.name}. Attempting fix...`);
            if (maxRetries > 0) {
              // Append fix instruction and retry
              const fixMessages: Msg[] = [
                ...messages,
                { role: "assistant", content },
                { role: "user", content: `CRITICAL FORMAT ERROR: ${rule.fixPrompt}\n\nPlease regenerate the ENTIRE response with the correct format.` }
              ];
              return callDeepSeek(fixMessages, temperature * 0.9, taskType, maxRetries - 1);
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

// ============================================================================
// EXAM PATTERN RETRIEVAL (Enhanced)
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
    pattern += `\n## CRITICAL EXAM PATTERN RULES:\n${exam.question_pattern}\n`;
  }
  
  // Inject structural metadata if available
  if (exam.subject) pattern += `Subject: ${exam.subject}\n`;
  
  if (pattern) {
    pattern += `\n⚠️ COMPLIANCE MANDATE: You MUST strictly adhere to the above pattern. Any deviation is unacceptable.\n`;
  }
  
  return pattern;
}

// ============================================================================
// DOCUMENT TASKS (Enhanced with Structured Prompts)
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
    
    // Use semantic slicing instead of naive slice
    const content = sliceByTokens(doc.content, maxContext * 0.5, 2000);

    const promptConfigs: Record<typeof data.task, { system: string; user: string; temp: number }> = {
      summary: {
        system: `${BASE_SYSTEM_CONSTRAINTS}\n\nWrite a comprehensive yet accessible summary. Structure with clear headings, bullet points, and bold key terms. Include a 3-sentence elevator pitch at the top.`,
        user: `Write a clear, structured summary of this study material.\n\nTITLE: ${doc.title}\n\nMATERIAL:\n${content}`,
        temp: 0.4
      },
      short_notes: {
        system: `${BASE_SYSTEM_CONSTRAINTS}\n\nConvert material into ultra-concise exam notes. Use bullet points, bold key terms, and tables for comparisons. One page max.`,
        user: `Create concise short notes from this material.\n\nTITLE: ${doc.title}\n\nMATERIAL:\n${content}`,
        temp: 0.3
      },
      revision_notes: {
        system: `${BASE_SYSTEM_CONSTRAINTS}\n\nCreate exam-ready revision notes. Include: key concepts, definitions, formulas, common exam traps, and '⚠️ Remember' tips.`,
        user: `Create revision notes for this material.\n\nTITLE: ${doc.title}\n\nMATERIAL:\n${content}`,
        temp: 0.3
      },
      quiz: {
        system: `${BASE_SYSTEM_CONSTRAINTS}\n\nGenerate exactly 8 MCQs with 4 options each (A-D). Mark correct answer as **[Correct: X]**. Include brief explanation after each answer.`,
        user: `Generate 8 multiple-choice questions testing understanding of this material.\n\nTITLE: ${doc.title}\n\nMATERIAL:\n${content}\n\nFORMAT:\n1. [Question]?\nA) [Option]\nB) [Option]\nC) [Option]\nD) [Option]\n**[Correct: X]**\n*Explanation: [Why this is correct based on material]*`,
        temp: 0.5
      },
      flashcards: {
        system: `${BASE_SYSTEM_CONSTRAINTS}\n\nGenerate exactly 10 flashcards. Format strictly as: Q: [Question]? / A: [Answer]. Ensure answers are concise (1-2 sentences).`,
        user: `Generate 10 flashcards covering the most important concepts.\n\nTITLE: ${doc.title}\n\nMATERIAL:\n${content}`,
        temp: 0.4
      },
      mindmap: {
        system: `${BASE_SYSTEM_CONSTRAINTS}\n\nProduce a hierarchical markdown outline using nested bullets (━, ┣, ┗). Show topic hierarchy clearly.`,
        user: `Create a mind-map outline of this material.\n\nTITLE: ${doc.title}\n\nMATERIAL:\n${content}`,
        temp: 0.3
      },
      important_topics: {
        system: `${BASE_SYSTEM_CONSTRAINTS}\n\nList exactly 8 topics ranked by exam relevance. Format: **1. [Topic]** — [Justification with citation to material].`,
        user: `List the 8 most important topics in this material for exam preparation.\n\nTITLE: ${doc.title}\n\nMATERIAL:\n${content}`,
        temp: 0.3
      },
      viva: {
        system: `${BASE_SYSTEM_CONSTRAINTS}\n\nGenerate 10 viva questions of increasing difficulty (Easy→Medium→Hard). Include 2-line ideal answers.`,
        user: `Generate 10 viva/oral exam questions with ideal answers.\n\nTITLE: ${doc.title}\n\nMATERIAL:\n${content}`,
        temp: 0.4
      },
      mock_exam: {
        system: `${BASE_SYSTEM_CONSTRAINTS}\n${EXAM_PATTERN_CONSTRAINTS}\n\n${FEW_SHOT_MOCK_EXAM}\n\nGenerate a FULL mock exam based ONLY on the provided material. You MUST follow the exact exam pattern specified.`,
        user: `Generate a complete Mock Exam based ONLY on this material.\n\nTITLE: ${doc.title}\n${examPattern}\n\nMATERIAL:\n${content}\n\nREQUIREMENTS:\n- Match the exact module/marks structure from the pattern above\n- Include internal choice indicators (OR / alternative questions)\n- Total must equal the specified marks\n- Questions must be answerable from the material only`,
        temp: 0.6
      },
    };

    const config = promptConfigs[data.task];
    const answer = await callDeepSeek(
      [
        { role: "system", content: config.system },
        { role: "user", content: config.user },
      ],
      config.temp,
      data.task === "mock_exam" || data.task === "quiz" || data.task === "flashcards" || data.task === "study_plan" ? data.task : undefined
    );
    
    return { answer };
  });

// ============================================================================
// CHAT WITH DOCUMENT (Enhanced with Citation Requirements)
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

    let contextText = "";
    let docTitle = "";
    let systemPrompt = `${BASE_SYSTEM_CONSTRAINTS}\n\nYou are a helpful study tutor. Answer concisely but thoroughly. When referencing material, cite [Source: Document].`;

    if (data.documentId) {
      const { data: doc } = await supabase
        .from("documents")
        .select("title, content, exam_id")
        .eq("id", data.documentId)
        .single();
      if (doc) {
        docTitle = doc.title;
        contextText = sliceByTokens(doc.content, maxContext * 0.45, 2500);
        const examPattern = await getExamPattern(supabase, doc.exam_id);
        systemPrompt = `${BASE_SYSTEM_CONSTRAINTS}\n${examPattern}\n\n## MATERIAL CONTEXT:\n${contextText}\n\n## INSTRUCTIONS:\n- Answer using ONLY the material above\n- Cite specific sections when possible: [Source: ${doc.title}, Section X]\n- If unsure, say: "I can only answer based on the provided document, and this information is not present."\n- Keep answers under 300 words unless the question requires detail`;
      }
    } else {
      // General chat: inject upcoming exams as context
      const { data: exams } = await supabase
        .from("exams")
        .select("subject, exam_date, priority, notes")
        .eq("user_id", userId)
        .order("exam_date", { ascending: true });

      if (exams && exams.length > 0) {
        const examsList = exams
          .map((e) => `- **${e.subject}** on ${new Date(e.exam_date).toLocaleDateString()} (Priority: ${e.priority})`)
          .join("\n");
        systemPrompt = `${BASE_SYSTEM_CONSTRAINTS}\n\nYou are a study planner. You may ONLY discuss the user's upcoming exams. No outside knowledge.\n\nEXAM SCHEDULE:\n${examsList}\n\nIf asked about subjects not in this schedule, say: "I can only discuss your scheduled exams. Please upload documents for subject-specific questions."`;
      }
    }

    // Fetch recent history with deduplication guard
    const baseQuery = supabase
      .from("chat_messages")
      .select("role, content")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(10); // Reduced to save tokens, reversed below
      
    const history = data.documentId
      ? await baseQuery.eq("document_id", data.documentId)
      : await baseQuery.is("document_id", null);

    const historyMessages = ((history.data ?? []) as Msg[]).reverse();
    
    // Deduplicate: remove consecutive duplicate messages
    const dedupedHistory: Msg[] = [];
    for (const msg of historyMessages) {
      if (dedupedHistory.length === 0 || dedupedHistory[dedupedHistory.length - 1].content !== msg.content) {
        dedupedHistory.push(msg);
      }
    }

    const messages: Msg[] = [
      { role: "system", content: systemPrompt },
      ...dedupedHistory,
      { role: "user", content: data.question },
    ];

    // Persist user message immediately to ensure correct chronological ordering
    await supabase.from("chat_messages").insert({ user_id: userId, document_id: data.documentId, role: "user", content: data.question });

    const answer = await callDeepSeek(messages, 0.4);

    // Persist assistant message
    await supabase.from("chat_messages").insert({ user_id: userId, document_id: data.documentId, role: "assistant", content: answer });

    return { answer };
  });

// ============================================================================
// STUDY PLAN (Enhanced with Strict Validation & Few-Shot)
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

    const promptContent = `You are an elite university study strategist. Produce a data-driven, hyper-specific study plan.

## EXAM PROFILE
- Subject: ${exam.subject}
- Days Remaining: ${days}
- Priority: ${exam.priority}
- Student Notes: ${exam.notes || "(none)"}
${examPattern}

## FEW-SHOT EXAMPLE OF CORRECT PHASE
${FEW_SHOT_STUDY_PLAN}

## MANDATORY OUTPUT STRUCTURE
You MUST follow this exact structure. Do not deviate.

# 📊 Exam Dashboard
- Today's Date: ${todayStr}
- Exam Date: ${examDateStr}
- Days Left: ${days}
- Daily Study Hours: [Suggest based on days left]
- Total Available Hours: [Calculate]
- High-Risk Modules: [List based on pattern]

---

## 🎯 Module Priority Ranking
Rank modules by scoring probability. Include: repeat %, tier counts, marks potential.
> Focus 60% of time on Top 2 modules.

---

## 📅 Phase-Wise Plan

### PHASE 1: High-Yield Sprint (Day 1 to Day ${Math.ceil(days * 0.3)})
[Detailed daily structure with specific hours and deliverables]

### PHASE 2: Gap Filling (Day ${Math.ceil(days * 0.3) + 1} to Day ${Math.ceil(days * 0.7)})
[Detailed daily structure]

### PHASE 3: Exam Simulation (Day ${Math.ceil(days * 0.7) + 1} to Day ${days})
[Detailed daily structure]

---

## ⏰ Daily Schedule Template
| Time Block | Activity | Module/Focus | Target Output |
|---|---|---|---|
[Fill with realistic hourly blocks]

---

## 🎲 Q5 vs Q6 Choice Strategy
[Built-in alternating prep strategy with decision rules]

---

## ⚠️ Contingency Rules
- IF days < 7: [Specific actions]
- IF days 7-14: [Specific actions]
- IF days 15-30: [Specific actions]
- IF days > 30: [Specific actions]

---

## ✅ Deliverables Checklist
1. Day-by-day calendar (${todayStr} to ${examDateStr})
2. Tier S question list with dates
3. One-page Exam Day Cheat Sheet

## CONSTRAINTS
- ZERO generic advice (no "stay hydrated" unless 1-line footer)
- Every activity MUST map to a specific module/question tier
- Must be realistic: if suggesting 4h/day, don't plan 6h of work
- If multiple subjects, specify subject-switching logic`;

    const plan = await callDeepSeek(
      [
        {
          role: "system",
          content: `You are an elite, highly professional university study strategist. You produce extremely detailed, data-driven markdown plans exactly matching the requested structure. ${EXAM_PATTERN_CONSTRAINTS}`,
        },
        { role: "user", content: promptContent },
      ],
      0.5,
      "study_plan"
    );

    await supabase.from("exams").update({ study_plan: plan }).eq("id", data.examId);
    return { plan };
  });

// ============================================================================
// EXAM SPACE CHAT (Enhanced Multi-Document Context)
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
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const maxContext = getModelContextLimit();

    // Fetch ALL documents for this exam
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

    // Smart multi-document context building with token budget
    let materialContext = "";
    let usedTokens = 0;
    const budgetPerDoc = docs && docs.length > 0 
      ? Math.floor((maxContext * 0.4) / docs.length) 
      : 0;

    if (docs && docs.length > 0) {
      for (const doc of docs) {
        const sliced = sliceByTokens(doc.content, budgetPerDoc, 500);
        materialContext += `\n--- Document: ${doc.title} ---\n${sliced}\n`;
        usedTokens += estimateTokens(sliced);
        if (usedTokens > maxContext * 0.45) break; // Hard cap
      }
    }

    let systemPrompt: string;
    if (materialContext) {
      systemPrompt = `${BASE_SYSTEM_CONSTRAINTS}\n${examPattern}\n\n## AVAILABLE MATERIALS FOR ${examSubject}:\n${materialContext}\n\n## CRITICAL RULES:\n1. You have access to ${docs?.length || 0} documents above\n2. Cite which document you used: [Source: Document Title]\n3. If information spans multiple docs, cite all relevant ones\n4. If answer not in materials: "I can only answer based on the uploaded documents for ${examSubject}, and this information is not present."\n5. Be concise but complete. Use markdown formatting.`;
    } else {
      systemPrompt = `You are a study tutor for ${examSubject}. The student has not uploaded any documents yet. Politely inform them they need to upload notes, PDFs, or question papers before you can help. Do not answer academic questions without materials.`;
    }

    // Fetch thread history
    const { data: history } = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("thread_id", data.threadId)
      .order("created_at", { ascending: true })
      .limit(20); // Reduced for token efficiency

    const messages: Msg[] = [
      { role: "system", content: systemPrompt },
      ...((history?.data ?? history ?? []) as Msg[]),
      { role: "user", content: data.question },
    ];

    // Persist user message immediately to ensure correct chronological ordering
    await supabase.from("chat_messages").insert({ user_id: userId, thread_id: data.threadId, role: "user", content: data.question });

    const answer = await callDeepSeek(messages, 0.4);

    // Persist assistant message
    await supabase.from("chat_messages").insert({ user_id: userId, thread_id: data.threadId, role: "assistant", content: answer });

    return { answer };
  });

// ============================================================================
// GENERAL THREAD CHAT (Enhanced Isolation)
// ============================================================================

export const chatInThread = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      threadId: z.string().uuid(),
      question: z.string().min(1).max(2000),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: exams } = await supabase
      .from("exams")
      .select("id, subject, exam_date, priority, notes")
      .eq("user_id", userId)
      .order("exam_date", { ascending: true });

    let systemPrompt = `${BASE_SYSTEM_CONSTRAINTS}\n\nYou are a professional AI Study Assistant and Planner.`;
    
    if (exams && exams.length > 0) {
      const examsList = exams
        .map((e) => `- **${e.subject}** on ${new Date(e.exam_date).toLocaleDateString()} (Priority: ${e.priority}, ID: ${e.id})`)
        .join("\n");
      systemPrompt += `\n\n## UPCOMING EXAMS:\n${examsList}\n\n## CRITICAL ISOLATION RULES:\n1. You do NOT have access to uploaded PDFs/notes in this General tab\n2. For subject-specific questions (e.g., asking for Biology notes or topics), you MUST NOT answer using outside knowledge\n3. Instead, politely explain you don't have access in this General Assistant tab and redirect them to the specific Study Space.\n4. You MUST provide the redirection link exactly in this format: [Open Subject Name Study Space](/exams/EXAM_ID) — replace "Subject Name" with the actual subject and EXAM_ID with the exact ID from the schedule above.\n5. You MAY discuss scheduling, prioritization, and general study strategies`;
    }

    const { data: history } = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("thread_id", data.threadId)
      .order("created_at", { ascending: true })
      .limit(20);

    const messages: Msg[] = [
      { role: "system", content: systemPrompt },
      ...((history?.data ?? history ?? []) as Msg[]),
      { role: "user", content: data.question },
    ];

    // Persist user message immediately to ensure correct chronological ordering
    await supabase.from("chat_messages").insert({ user_id: userId, thread_id: data.threadId, role: "user", content: data.question });

    const answer = await callDeepSeek(messages, 0.4);

    // Persist assistant message
    await supabase.from("chat_messages").insert({ user_id: userId, thread_id: data.threadId, role: "assistant", content: answer });

    return { answer };
  });

// ============================================================================
// THREAD TITLE GENERATION (Enhanced)
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

    const title = await callDeepSeek(
      [
        {
          role: "system",
          content: `Generate a concise chat title (3-5 words) that captures the academic topic.\nRules:\n- NO quotes, NO punctuation at end\n- Prefer: "Calculus Integration", "Exam Strategy", "Cloud Computing Module 3"\n- Avoid: "Discussion about...", "Question regarding..."\n- Reply with ONLY the title text`,
        },
        { role: "user", content: data.firstMessage },
      ],
      0.3
    );

    const cleanTitle = title.replace(/^["']|["']$/g, "").replace(/[.:;]$/, "").trim().slice(0, 60) || "New Chat";
    await supabase.from("chat_threads").update({ title: cleanTitle }).eq("id", data.threadId);
    return { title: cleanTitle };
  });

// ============================================================================
// EDIT & RESEND (Enhanced with Context Rebuild)
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
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: msg } = await supabase
      .from("chat_messages")
      .select("created_at")
      .eq("id", data.messageId)
      .single();
    if (!msg) throw new Error("Message not found");

    // Delete this message and everything after it
    await supabase
      .from("chat_messages")
      .delete()
      .eq("thread_id", data.threadId)
      .gte("created_at", msg.created_at);

    // Re-send with edited content
    if (data.examId) {
      return chatInExamSpace({
        data: { examId: data.examId, threadId: data.threadId, question: data.newContent },
      } as any);
    } else {
      return chatInThread({
        data: { threadId: data.threadId, question: data.newContent },
      } as any);
    }
  });

// ============================================================================
// AI NOTE FORMATTING (Enhanced with Structure Validation)
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
      throw new Error("Note is too short to format. Write some content first.");
    }

    const maxContext = getModelContextLimit();
    const content = sliceByTokens(doc.content, maxContext * 0.55, 2000);

    const formatted = await callDeepSeek(
      [
        {
          role: "system",
          content: `You are an expert academic note formatter. Transform raw notes into beautifully structured, exam-ready markdown.

## FORMATTING RULES:
1. **Headings**: ## for main topics, ### for subtopics
2. **Key Terms**: Bold (**term**) all important concepts
3. **Lists**: Convert paragraphs into bullets or numbered lists
4. **Tables**: Use markdown tables for comparisons
5. **Definitions**: Format as "> **Term**: Definition"
6. **Formulas**: Wrap in backticks for inline code
7. **Dividers**: Use --- between major sections
8. **Summary**: Add "📋 Key Takeaways" at the end
9. **Mnemonics**: Suggest memory aids in *italics* where applicable
10. **Highlights**: Use "⚡ Important" or "📝 Note" prefixes

## CRITICAL CONSTRAINTS:
- Do NOT add information not in the original
- Do NOT remove information from the original
- ONLY restructure, reformat, reorganize
- Fix grammar/spelling
- Make it scannable — quick topic lookup should be easy

## OUTPUT VALIDATION:
Before finishing, verify:\n- At least 2 heading levels present\n- Key terms are bolded\n- Has a Key Takeaways section\n- No raw HTML tags`,
        },
        {
          role: "user",
          content: `Format these study notes into clean, professional, exam-ready markdown:\n\n${content}`,
        },
      ],
      0.3,
      "format_notes"
    );

    // Extract title from formatted content
    const titleMatch = formatted.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : doc.title;

    const { error: updateError } = await supabase
      .from("documents")
      .update({ content: formatted, title })
      .eq("id", data.noteId);
    if (updateError) throw new Error("Failed to save formatted note");

    return { formatted };
  });

// ============================================================================
// EXAM PATTERN EXTRACTION (Enhanced with Schema)
// ============================================================================

export const extractExamPattern = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ text: z.string().min(10) }).parse(d),
  )
  .handler(async ({ data }) => {
    const prompt = `You are an expert academic assistant. Read the provided text extracted from a university exam question paper (which might contain OCR errors) and output a concise, structured summary of its question pattern.

## EXTRACTION RULES:
- Identify: module count, marks per section, internal choices, compulsory questions
- Note any special instructions (calculator allowed, choice rules, etc.)
- Keep under 100 words
- Use this exact format:

**Modules:** [N] | **Total Marks:** [N] | **Duration:** [N] hrs
- Q1: [Compulsory/Choice] — [Marks]
- Q2-Q[N]: [Pattern with internal choice details]
- Special: [Any notable rules]

## PAPER TEXT:
${sliceByTokens(data.text, 12000, 2000)}`;

    const pattern = await callDeepSeek(
      [
        {
          role: "system",
          content: "Extract concise exam patterns from raw text. Output only the structured pattern. No generic advice.",
        },
        { role: "user", content: prompt },
      ],
      0.3
    );

    return { pattern };
  });
