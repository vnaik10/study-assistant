import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const AI_BASE_URL = (process.env.AI_BASE_URL || "https://openrouter.ai/api/v1")
  .replace(/\/+$/, "")
  .replace(/\/chat\/completions$/, "");
const AI_CHAT_ENDPOINT = `${AI_BASE_URL}/chat/completions`;

const DEFAULT_EXAM_PATTERN = `
CRITICAL EXAM PATTERN RULES:
Whenever the user asks you to generate a question paper, mock exam, or questions for a module, you MUST strictly follow this exact university pattern:
1. The exam consists of 5 Modules. Each module is worth exactly 20 marks.
2. In each module, there is an internal choice between TWO full questions (e.g., Q1 OR Q2). The student must answer one full question from each module.
3. Each full question (e.g., Q1) is subdivided into parts (a, b, c).
4. The marks for the parts of a single full question MUST sum to exactly 20 marks.
5. Valid mark distributions for a 20-mark question are typically: (10, 10), (8, 6, 6), (10, 5, 5), or (6, 6, 8). 
6. Format your mock exams clearly with "OR" separating the internal choices in each module, and indicate the marks for each sub-question.
`;

async function getExamPattern(supabase: any, examId?: string | null): Promise<string> {
  let pattern = DEFAULT_EXAM_PATTERN;
  if (examId) {
    const { data: exam } = await supabase.from("exams").select("question_pattern").eq("id", examId).single();
    if (exam?.question_pattern && exam.question_pattern.trim().length > 0) {
      pattern = `\nCRITICAL EXAM PATTERN RULES:\nWhenever you generate a mock exam, questions, or study plan, strictly follow this pattern provided by the user:\n${exam.question_pattern}\n`;
    }
  }
  return pattern;
}

type Msg = { role: "system" | "user" | "assistant"; content: string };

async function callDeepSeek(messages: Msg[], temperature = 0.4): Promise<string> {
  // Completely transition to OpenRouter API Key
  const key = process.env.OPENROUTER_API_KEY || process.env.AGENT_ROUTER_TOKEN || process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not configured in .env");

  const model = process.env.AI_MODEL || "deepseek/deepseek-chat";
  const payload = JSON.stringify({ model, messages, temperature });

  // Retry up to 2 times for transient 5xx / network errors
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * attempt)); // backoff
    }

    try {
      const res = await fetch(AI_CHAT_ENDPOINT, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:5173",
          "X-Title": "AI Study Assistant",
        },
        body: payload,
      });

      if (res.status === 401) {
        const txt = await res.text();
        throw new Error(
          `AI authentication failed (401). Check your OPENROUTER_API_KEY. Response: ${txt.slice(0, 300)}`
        );
      }

      if (res.status === 429) {
        // Rate limited — wait and retry
        lastError = new Error("Rate limited by AI provider");
        continue;
      }

      if (res.status >= 500) {
        lastError = new Error(`AI provider returned ${res.status}`);
        continue;
      }

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`AI error ${res.status}: ${txt.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return data.choices?.[0]?.message?.content ?? "";
    } catch (e) {
      if (e instanceof Error && e.message.includes("401")) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  throw lastError ?? new Error("AI call failed after retries");
}

/** Generic AI task on a document's content. */
export const runDocTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
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
      })
      .parse(d),
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

    const prompts: Record<typeof data.task, string> = {
      summary:
        "Write a clear, beginner-friendly summary of the following study material. Use simple language, headings, and bullet points.",
      short_notes:
        "Convert the following material into concise short notes with bullet points and key terms in **bold**.",
      revision_notes:
        "Create exam-ready revision notes: key concepts, definitions, formulas, and 'remember this' tips. Use headings.",
      quiz: "Generate 8 multiple-choice questions (with 4 options each and the correct answer marked) testing understanding of this material. Format as a numbered list.",
      flashcards:
        "Generate 10 flashcards as a list of 'Q: ... / A: ...' pairs covering the most important concepts.",
      mindmap:
        "Produce a mind-map style outline (markdown nested bullets) showing the hierarchy of topics and subtopics.",
      important_topics:
        "List the 8 most important topics in this material, ranked by likely exam relevance, with a one-line justification each.",
      viva: "Generate 10 viva/oral-exam questions of increasing difficulty, with a short ideal answer for each.",
      mock_exam: "Generate a full Mock Exam based ONLY on this material. You MUST strictly adhere to the university exam pattern provided in your instructions (5 modules, 20 marks each, internal choice).",
    };

    const content = doc.content.slice(0, 12000);
    const answer = await callDeepSeek(
      [
        {
          role: "system",
          content: `You are a strict, expert tutor. You MUST ONLY use the provided material. Do not use outside knowledge. Always reply in clean markdown.\n\n${examPattern}`,
        },
        {
          role: "user",
          content: `${prompts[data.task]}\n\nMATERIAL (title: ${doc.title}):\n${content}`,
        },
      ],
      0.5,
    );
    return { answer };
  });

/** Chat with a document (RAG-lite — pass full content). */
export const chatWithDoc = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        documentId: z.string().uuid().nullable(),
        question: z.string().min(1).max(2000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    let contextText = "";
    let docTitle = "";
    let systemPrompt = "You are a helpful study tutor. Reply in clean markdown.";

    if (data.documentId) {
      const { data: doc } = await supabase
        .from("documents")
        .select("title, content, exam_id")
        .eq("id", data.documentId)
        .single();
      if (doc) {
        docTitle = doc.title;
        contextText = doc.content.slice(0, 10000);
        const examPattern = await getExamPattern(supabase, doc.exam_id);
        systemPrompt = `You are a strict AI study tutor. You MUST ONLY answer questions using the information provided in the material below. Under NO circumstances should you use outside knowledge or pre-trained information. If the user asks a question that cannot be answered using the provided material, you must strictly reply: 'I can only answer based on the provided document, and this information is not present.' Do not guess or infer beyond the given text. Always reply in clean markdown.\n\n${examPattern}\n\nMATERIAL:\n${contextText}`;
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
        systemPrompt = `You are a strict AI study planner. You must ONLY answer questions based on the user's upcoming exam schedule provided below. Do not use outside knowledge. If the user asks about topics or subjects not present in this schedule, refuse to answer and remind them to open a specific document to ask subject-related questions. Reply in clean markdown.\n\nEXAM SCHEDULE:\n${examsList}`;
      }
    }

    // recent history
    const baseQuery = supabase
      .from("chat_messages")
      .select("role, content")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(20);
    const history = data.documentId
      ? await baseQuery.eq("document_id", data.documentId)
      : await baseQuery.is("document_id", null);

    const messages: Msg[] = [
      {
        role: "system",
        content: systemPrompt,
      },
      ...((history.data ?? []) as Msg[]),
      { role: "user", content: data.question },
    ];

    const answer = await callDeepSeek(messages, 0.4);

    // persist both messages
    await supabase.from("chat_messages").insert([
      {
        user_id: userId,
        document_id: data.documentId,
        role: "user",
        content: data.question,
      },
      {
        user_id: userId,
        document_id: data.documentId,
        role: "assistant",
        content: answer,
      },
    ]);

    return { answer };
  });

/** Generate a personalized study plan for an exam. */
export const generateStudyPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ examId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: exam } = await supabase
      .from("exams")
      .select("subject, exam_date, priority, notes, question_pattern")
      .eq("id", data.examId)
      .single();
    if (!exam) throw new Error("Exam not found");

    const examPattern = await getExamPattern(supabase, data.examId);

    const days = Math.max(
      1,
      Math.ceil((new Date(exam.exam_date).getTime() - Date.now()) / 86_400_000),
    );

    const todayStr = new Date().toLocaleDateString();
    const examDateStr = new Date(exam.exam_date).toLocaleDateString();

    const promptLines = [
      "Create a professional, highly strategic study plan for a **" + exam.subject + "** exam.",
      "Days remaining: " + days + " days.",
      "Priority Level: " + exam.priority + ".",
      "Student notes: " + (exam.notes || "(none)") + ".",
      "",
      examPattern,
      "",
      "You MUST strictly follow the output structure and constraints provided below.",
      "",
      "OUTPUT STRUCTURE:",
      "",
      "## Exam Dashboard",
      "- Today's Date: " + todayStr,
      "- Exam Date: " + examDateStr,
      "- Days Left: " + days,
      "- Daily Study Hours: (Suggest a realistic number based on days left)",
      "- Total Available Study Hours: (Calculate based on your suggestion)",
      "- High-Risk Modules: (List low repetition, high weightage modules)",
      "",
      "---",
      "",
      "## Module Priority Ranking (Based on PYQ Repetition + Weightage)",
      "Rank modules from highest to lowest scoring probability:",
      "1. Module [X] - [Z%] of repeated questions, [Y] Tier S questions, estimated [W] marks potential",
      "2. Module [Y] - ...",
      '(Include note: "Focus 60% of remaining time on Top 2 modules")',
      "",
      "---",
      "",
      "## Phase-Wise Study Plan",
      "",
      "### PHASE 1: High-Yield Sprint (Day 1 to Day [30% of total days])",
      "GOAL: Secure definite marks. Master all Tier S questions.",
      "- Focus: Modules with highest repeat rate + Q5/Q6 choice-section questions",
      "- Method: Repeated question solving, formula memorization, theory verbatim",
      "- Daily Structure Template:",
      "  - Hour 1-2: Tier S questions from Top Priority Module",
      "  - Hour 3-4: Tier A questions + Q5/Q6 section mapping",
      "  - Hour 5-6: Revision of same day content + flashcards",
      "",
      "### PHASE 2: Gap Filling and Probability Boost (Day [31%] to Day [70%])",
      "GOAL: Cover Tier A and Tier B. Strengthen weak areas in high-priority modules.",
      "- Focus: Questions that appeared 2 times + emerging patterns from last 2 papers",
      "- Method: Mock section attempts (practice choosing Q5 vs Q6 under timed conditions)",
      "- Daily Structure Template:",
      "  - Hour 1-2: New module coverage (Module 3/4 if not covered)",
      "  - Hour 3-4: Numerical/problem practice for Tier C questions",
      "  - Hour 5-6: PYQ simulation - attempt one full section (Q5 or Q6) in 45 minutes",
      "",
      "### PHASE 3: Exam Simulation and Revision (Last 30% of days, minimum 3 days)",
      "GOAL: Maximize recall speed. Finalize Q5 vs Q6 choice strategy.",
      "- Focus: Full paper simulation, last-minute formula sheets, Tier S rapid revision",
      "- Method: Timed mock tests, section-choice decision drills",
      "- Daily Structure Template:",
      "  - Morning (2 hrs): Rapid revision of Tier S list",
      "  - Afternoon (2 hrs): Full mock paper or half-paper (Q5/Q6 choice practice)",
      "  - Evening (2 hrs): Error log review + weak spot patching",
      "",
      "---",
      "",
      "## Daily Schedule Template (Adjust per phase)",
      "",
      "| Time Block | Activity | Module/Focus | Target Output |",
      "|---|---|---|---|",
      "| 08:00-10:00 | Deep Study | [Module X] Tier S | Solve 3 repeated questions perfectly |",
      "| 10:30-12:30 | Deep Study | [Module Y] Tier A | Cover 2 high-probability questions |",
      "| 14:00-16:00 | Practice/Problems | Numerical section | 5 problems from Q5/Q6 mapped questions |",
      "| 16:30-18:00 | Revision | Morning recap | Rewrite formulas without looking |",
      "| 19:00-20:00 | Light Review | Flashcards/Theory | 20 theory points from repeated questions |",
      "| 20:00-21:00 | Planning | Next day prep + error log | List 3 weak points to fix tomorrow |",
      "",
      "---",
      "",
      "## Q5 vs Q6 Choice Strategy (Built into the plan)",
      "",
      "Based on PYQ analysis, your daily plan should alternate preparation:",
      "",
      "If Q5 is historically stronger for Module 3:",
      "- Odd days: Primary prep on Q5(a) and Q5(b) type questions",
      "- Even days: Backup prep on Q6 (insurance questions)",
      "",
      "If Q6 is historically stronger:",
      "- Reverse the above.",
      "",
      "Exam Day Decision Rule:",
      "- 5-minute paper scan: Identify which section has MORE repeated/Tier S questions",
      "- Pre-decided fallback: If unclear in exam, default to [Q5/Q6 based on historical data]",
      "",
      "---",
      "",
      "## Contingency Rules (Auto-adjust based on days left)",
      "",
      "IF days remaining < 7:",
      "- Drop Tier B and C entirely. Only Tier S + last 2 year papers.",
      "- 4 hours/day minimum.",
      "",
      "IF days remaining 7-14:",
      "- Skip low-weightage modules. Focus only on Top 2 modules + Q5/Q6 sections.",
      "- 50% time on repetition, 50% on mock practice.",
      "",
      "IF days remaining 15-30:",
      '- Full plan as above. Add one "rest day" every 6 days.',
      "",
      "IF days remaining > 30:",
      "- Add deep concept days for understanding, not just memorization.",
      "- Include buffer days for unexpected delays.",
      "",
      "---",
      "",
      "## Deliverables Checklist",
      "Provide these at the end:",
      "1. Day-by-day calendar (Date: " + todayStr + " to " + examDateStr + ") with module assignments",
      "2. Tier S question list integrated into specific dates",
      "3. One-page Exam Day Cheat Sheet with:",
      "   - Top 10 must-remember formulas/theory points",
      "   - Q5 vs Q6 decision flowchart",
      "   - Time allocation per section (e.g., 20 min for Q1, 45 min for Q5/Q6 choice)",
      "",
      "CONSTRAINTS:",
      '- Do NOT include generic advice like "stay hydrated" unless in a 1-line footer.',
      "- Every activity must map to a specific module or question tier.",
      "- If I have multiple subjects, create separate phase blocks and specify subject-switching logic.",
      "- The plan must be realistic: if I say 4 hours/day, do not plan 6 hours of work.",
    ];

    const promptContent = promptLines.join("\n");

    const plan = await callDeepSeek(
      [
        {
          role: "system",
          content: "You are an elite, highly professional university study strategist. You produce extremely detailed, data-driven markdown plans exactly matching the requested structure.",
        },
        {
          role: "user",
          content: promptContent,
        },
      ],
      0.5,
    );

    await supabase.from("exams").update({ study_plan: plan }).eq("id", data.examId);

    return { plan };
  });

/** Chat within an exam space — strict isolation to that exam's documents only. */
export const chatInExamSpace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        examId: z.string().uuid(),
        threadId: z.string().uuid(),
        question: z.string().min(1).max(2000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Fetch ALL documents for this specific exam only
    const { data: docs } = await supabase
      .from("documents")
      .select("title, content")
      .eq("exam_id", data.examId);

    // Fetch the exam info
    const { data: exam } = await supabase
      .from("exams")
      .select("subject")
      .eq("id", data.examId)
      .single();

    const examSubject = exam?.subject ?? "this exam";

    // Build context from ALL docs in this exam
    let materialContext = "";
    if (docs && docs.length > 0) {
      materialContext = docs
        .map((d) => `--- Document: ${d.title} ---\n${d.content.slice(0, 8000)}`)
        .join("\n\n");
    }

    let systemPrompt: string;
    if (materialContext) {
      const examPattern = await getExamPattern(supabase, data.examId);
      systemPrompt = `You are a strict AI study tutor for the subject "${examSubject}". You MUST ONLY answer questions using the information provided in the materials below. Under NO circumstances should you use outside knowledge or pre-trained information. If the user asks a question that cannot be answered using the provided materials, you must strictly reply: 'I can only answer based on the uploaded documents for ${examSubject}, and this information is not present in your materials.' Do not guess or infer beyond the given text. Always reply in clean markdown.\n\n${examPattern}\n\nMATERIALS:\n${materialContext}`;
    } else {
      systemPrompt = `You are a strict AI study tutor for the subject "${examSubject}". The student has not uploaded any documents yet for this exam. Politely inform them that they need to upload notes, PDFs, or question papers before you can help them study. Do not answer academic questions without uploaded materials.`;
    }

    // Fetch thread history
    const { data: history } = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("thread_id", data.threadId)
      .order("created_at", { ascending: true })
      .limit(30);

    const messages: Msg[] = [
      { role: "system", content: systemPrompt },
      ...((history?.data ?? history ?? []) as Msg[]),
      { role: "user", content: data.question },
    ];

    const answer = await callDeepSeek(messages, 0.4);

    // Persist both messages with thread_id
    await supabase.from("chat_messages").insert([
      {
        user_id: userId,
        thread_id: data.threadId,
        role: "user",
        content: data.question,
      },
      {
        user_id: userId,
        thread_id: data.threadId,
        role: "assistant",
        content: answer,
      },
    ]);

    return { answer };
  });

/** Chat in the general AI Tutor with thread support. */
export const chatInThread = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        threadId: z.string().uuid(),
        question: z.string().min(1).max(2000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // General chat: inject upcoming exams as context
    const { data: exams } = await supabase
      .from("exams")
      .select("subject, exam_date, priority, notes")
      .eq("user_id", userId)
      .order("exam_date", { ascending: true });

    let systemPrompt = "You are a professional AI Study Assistant. Reply in clean markdown.";
    if (exams && exams.length > 0) {
      const examsList = exams
        .map((e) => `- **${e.subject}** on ${new Date(e.exam_date).toLocaleDateString()} (Priority: ${e.priority})`)
        .join("\n");
      systemPrompt = `You are a professional AI Study Assistant and Planner. 
Your goal is to help the user manage their study schedule based on the upcoming exams provided below.

CRITICAL RULES:
1. STRICT ISOLATION: You currently do NOT have access to the user's uploaded PDFs or notes in this General Assistant tab. This is to maintain strict isolation between different subjects.
2. If the user asks a subject-specific question (e.g. "What are the module 1 questions for Cloud Computing?"), you MUST NOT try to answer it using outside knowledge. 
3. Instead, professionally and politely explain: "To ensure strict isolation between your subjects, I don't have access to your uploaded PDFs in this General Assistant tab. Please navigate to the **Exams** page and click the **Study Space** button on your specific exam card. Once inside the Study Space, I will have full access to all the PDFs and notes you uploaded for that subject!"
4. Reply in clean markdown.

EXAM SCHEDULE:
${examsList}`;
    }

    // Fetch thread history
    const { data: history } = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("thread_id", data.threadId)
      .order("created_at", { ascending: true })
      .limit(30);

    const messages: Msg[] = [
      { role: "system", content: systemPrompt },
      ...((history?.data ?? history ?? []) as Msg[]),
      { role: "user", content: data.question },
    ];

    const answer = await callDeepSeek(messages, 0.4);

    // Persist both messages
    await supabase.from("chat_messages").insert([
      {
        user_id: userId,
        thread_id: data.threadId,
        role: "user",
        content: data.question,
      },
      {
        user_id: userId,
        thread_id: data.threadId,
        role: "assistant",
        content: answer,
      },
    ]);

    return { answer };
  });

/** Auto-generate a short title for a thread based on the first message. */
export const generateThreadTitle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        threadId: z.string().uuid(),
        firstMessage: z.string().min(1),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const title = await callDeepSeek(
      [
        {
          role: "system",
          content: "Generate a very short title (3-6 words max) for this chat conversation. Reply with ONLY the title, nothing else. No quotes, no punctuation at the end.",
        },
        { role: "user", content: data.firstMessage },
      ],
      0.3,
    );

    const cleanTitle = title.replace(/^["']|["']$/g, "").trim().slice(0, 60) || "New Chat";
    await supabase.from("chat_threads").update({ title: cleanTitle }).eq("id", data.threadId);

    return { title: cleanTitle };
  });

/** Edit a previous message and regenerate AI response from that point. */
export const editAndResend = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        messageId: z.string().uuid(),
        threadId: z.string().uuid(),
        examId: z.string().uuid().nullable(),
        newContent: z.string().min(1).max(2000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Get the message to find its timestamp
    const { data: msg } = await supabase
      .from("chat_messages")
      .select("created_at")
      .eq("id", data.messageId)
      .single();
    if (!msg) throw new Error("Message not found");

    // Delete this message and everything after it in the thread
    await supabase
      .from("chat_messages")
      .delete()
      .eq("thread_id", data.threadId)
      .gte("created_at", msg.created_at);

    // Now re-send with the edited content
    if (data.examId) {
      // Use exam space chat
      const result = await chatInExamSpace({
        data: {
          examId: data.examId,
          threadId: data.threadId,
          question: data.newContent,
        },
      } as any);
      return result;
    } else {
      // Use general thread chat
      const result = await chatInThread({
        data: {
          threadId: data.threadId,
          question: data.newContent,
        },
      } as any);
      return result;
    }
  });

/** AI-powered note formatting — restructures messy notes into clean, exam-ready markdown. */
export const formatNoteWithAI = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        noteId: z.string().uuid(),
      })
      .parse(d),
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

    const formatted = await callDeepSeek(
      [
        {
          role: "system",
          content: `You are an expert academic note formatter. Your job is to take the user's raw study notes and transform them into beautifully structured, exam-ready markdown.

FORMATTING RULES:
1. **Structure**: Organize content with clear headings (## for main topics, ### for subtopics)
2. **Key Terms**: Bold (**term**) all important concepts, definitions, and keywords
3. **Lists**: Convert long paragraphs into clean bullet points or numbered lists
4. **Tables**: When comparing items, use markdown tables for clarity
5. **Definitions**: Format as "> **Term**: Definition" blockquote style
6. **Formulas/Equations**: Wrap in backticks for inline code style
7. **Section Dividers**: Use --- between major sections
8. **Summary Boxes**: Add a "📋 Key Takeaways" section at the end with the most exam-important points
9. **Mnemonics**: If applicable, suggest memory aids in italics
10. **Highlight Patterns**: Use "⚡ Important" or "📝 Note" prefixes for critical exam points

CRITICAL CONSTRAINTS:
- Do NOT add any information that is not present in the original notes
- Do NOT remove any information from the original notes
- ONLY restructure, reformat, and reorganize what is already there
- Fix grammar and spelling errors
- Improve sentence clarity while keeping the original meaning
- Make it scannable — a student should be able to quickly find any topic`,
        },
        {
          role: "user",
          content: `Please format and restructure these study notes into clean, professional, exam-ready markdown:\n\n${doc.content.slice(0, 15000)}`,
        },
      ],
      0.3,
    );

    // Extract title from formatted content
    const titleMatch = formatted.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : doc.title;

    // Save back
    const { error: updateError } = await supabase
      .from("documents")
      .update({ content: formatted, title })
      .eq("id", data.noteId);
    if (updateError) throw new Error("Failed to save formatted note");

    return { formatted };
  });


/** Auto-extract exam pattern from uploaded PDF or Image text */
export const extractExamPattern = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        text: z.string().min(10),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const prompt = `You are an expert academic assistant. Read the provided text extracted from a university exam question paper (which might contain OCR errors) and output a concise, structured summary of its question pattern.

FORMAT EXPECTATIONS:
- How many modules/sections are there?
- What are the marks per section/question?
- What are the internal choices (e.g., Q1 OR Q2 in Module 1)?
- Do NOT output generic advice, just the structural pattern.
- Keep it under 100 words.

PAPER TEXT:
${data.text.slice(0, 10000)}`;

    const pattern = await callDeepSeek(
      [
        {
          role: "system",
          content: "You extract concise exam patterns from raw syllabus or past paper text. Output plain text or very simple markdown. Keep it extremely brief.",
        },
        { role: "user", content: prompt },
      ],
      0.3,
    );

    return { pattern };
  });
