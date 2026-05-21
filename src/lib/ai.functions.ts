import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

type Msg = { role: "system" | "user" | "assistant"; content: string };

async function callDeepSeek(messages: Msg[], temperature = 0.4): Promise<string> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY is not configured");
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages,
      temperature,
      max_tokens: 2000,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`DeepSeek error ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
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
        ]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: doc, error } = await supabase
      .from("documents")
      .select("title, content")
      .eq("id", data.documentId)
      .single();
    if (error || !doc) throw new Error("Document not found");

    const prompts: Record<typeof data.task, string> = {
      summary:
        "Write a clear, beginner-friendly summary of the following study material. Use simple language, headings, and bullet points.",
      short_notes:
        "Convert the following material into concise short notes with bullet points and key terms in **bold**.",
      revision_notes:
        "Create exam-ready revision notes: key concepts, definitions, formulas, and 'remember this' tips. Use headings.",
      quiz:
        "Generate 8 multiple-choice questions (with 4 options each and the correct answer marked) testing understanding of this material. Format as a numbered list.",
      flashcards:
        "Generate 10 flashcards as a list of 'Q: ... / A: ...' pairs covering the most important concepts.",
      mindmap:
        "Produce a mind-map style outline (markdown nested bullets) showing the hierarchy of topics and subtopics.",
      important_topics:
        "List the 8 most important topics in this material, ranked by likely exam relevance, with a one-line justification each.",
      viva:
        "Generate 10 viva/oral-exam questions of increasing difficulty, with a short ideal answer for each.",
    };

    const content = doc.content.slice(0, 12000);
    const answer = await callDeepSeek(
      [
        {
          role: "system",
          content:
            "You are a friendly, expert tutor. Always reply in clean markdown.",
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
    if (data.documentId) {
      const { data: doc } = await supabase
        .from("documents")
        .select("title, content")
        .eq("id", data.documentId)
        .single();
      if (doc) {
        docTitle = doc.title;
        contextText = doc.content.slice(0, 10000);
      }
    }

    // recent history
    const history = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("user_id", userId)
      .eq("document_id", data.documentId)
      .order("created_at", { ascending: true })
      .limit(20);

    const messages: Msg[] = [
      {
        role: "system",
        content: contextText
          ? `You are a helpful study tutor answering questions about the document "${docTitle}". Answer using only the provided material when possible, and say so when something isn't covered. Always reply in clean markdown.\n\nMATERIAL:\n${contextText}`
          : "You are a helpful study tutor. Reply in clean markdown.",
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
      .select("subject, exam_date, priority, notes")
      .eq("id", data.examId)
      .single();
    if (!exam) throw new Error("Exam not found");

    const days = Math.max(
      1,
      Math.ceil(
        (new Date(exam.exam_date).getTime() - Date.now()) / 86_400_000,
      ),
    );

    const plan = await callDeepSeek(
      [
        {
          role: "system",
          content:
            "You are an expert study coach. Produce clean markdown plans.",
        },
        {
          role: "user",
          content: `Create a personalized day-by-day study plan for a ${exam.subject} exam in ${days} days. Priority: ${exam.priority}. Student notes: ${exam.notes ?? "(none)"}. Include daily topics, suggested durations, revision days, and the day before the exam should be light revision + rest.`,
        },
      ],
      0.5,
    );

    await supabase
      .from("exams")
      .update({ study_plan: plan })
      .eq("id", data.examId);

    return { plan };
  });
