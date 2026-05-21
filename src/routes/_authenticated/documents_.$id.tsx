import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useRef, useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "@/components/ui/markdown";
import { toast } from "sonner";
import { ArrowLeft, Send, Sparkles, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { chatWithDoc, runDocTask } from "@/lib/ai.functions";

export const Route = createFileRoute("/_authenticated/documents_/$id")({
  component: DocChat,
});

const TASKS = [
  { key: "summary", label: "Summary" },
  { key: "short_notes", label: "Short notes" },
  { key: "revision_notes", label: "Revision notes" },
  { key: "quiz", label: "Quiz (MCQ)" },
  { key: "flashcards", label: "Flashcards" },
  { key: "mindmap", label: "Mind map" },
  { key: "important_topics", label: "Important topics" },
  { key: "viva", label: "Viva questions" },
  { key: "mock_exam", label: "Mock Exam (20M pattern)" },
] as const;

type TaskKey = (typeof TASKS)[number]["key"];

function DocChat() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const chat = useServerFn(chatWithDoc);
  const task = useServerFn(runDocTask);
  const [input, setInput] = useState("");
  const [taskOutput, setTaskOutput] = useState<{ task: string; content: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const { data: doc } = useQuery({
    queryKey: ["doc", id],
    queryFn: async () => {
      const { data } = await supabase.from("documents").select("*").eq("id", id).single();
      return data;
    },
  });

  const { data: messages = [] } = useQuery({
    queryKey: ["messages", id],
    queryFn: async () => {
      const { data } = await supabase
        .from("chat_messages")
        .select("*")
        .eq("document_id", id)
        .order("created_at", { ascending: false })
        .limit(20);
      return (data ?? []).reverse();
    },
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const ask = useMutation({
    mutationFn: async (q: string) => chat({ data: { documentId: id, question: q } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["messages", id] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const runTask = useMutation({
    mutationFn: async (k: TaskKey) => {
      const res = await task({ data: { documentId: id, task: k } });
      return { task: k, content: res.answer };
    },
    onSuccess: (out) => setTaskOutput(out),
    onError: (e: Error) => toast.error(e.message),
  });

  const send = () => {
    const q = input.trim();
    if (!q) return;
    setInput("");
    ask.mutate(q);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b bg-card px-6 py-4">
        <Link
          to="/documents"
          className="mb-2 inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-3 w-3" /> Back to library
        </Link>
        <h1 className="font-display text-2xl font-semibold">{doc?.title ?? "Document"}</h1>
        {doc?.subject && <div className="text-sm text-muted-foreground">{doc.subject}</div>}
      </header>

      <div className="flex flex-wrap gap-2 border-b bg-muted/30 px-6 py-3">
        {TASKS.map((t) => (
          <Button
            key={t.key}
            size="sm"
            variant="outline"
            disabled={runTask.isPending}
            onClick={() => runTask.mutate(t.key)}
          >
            {runTask.isPending && runTask.variables === t.key ? (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="mr-1.5 h-3 w-3" />
            )}
            {t.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Chat */}
        <div className="flex flex-1 flex-col">
          <div className="flex-1 overflow-y-auto p-6">
            {!messages.length && (
              <div className="mx-auto max-w-md rounded-2xl border bg-card p-6 text-center">
                <Sparkles className="mx-auto h-6 w-6 text-primary" />
                <h3 className="mt-3 font-semibold">Ask anything about this document</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  The AI tutor answers from your uploaded material.
                </p>
              </div>
            )}
            <div className="mx-auto max-w-4xl space-y-4">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                      m.role === "user" ? "bg-primary text-primary-foreground" : "bg-card border"
                    }`}
                  >
                    {m.role === "user" ? (
                      <div className="whitespace-pre-wrap">{m.content}</div>
                    ) : (
                      <div className="prose prose-sm max-w-none text-foreground dark:prose-invert">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={markdownComponents}
                        >
                          {m.content}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {ask.isPending && (
                <div className="flex justify-start">
                  <div className="rounded-2xl border bg-card px-4 py-3 text-sm text-muted-foreground">
                    <Loader2 className="inline h-3 w-3 animate-spin" /> Thinking...
                  </div>
                </div>
              )}
              <div ref={endRef} />
            </div>
          </div>
          <div className="border-t bg-card p-4">
            <div className="mx-auto flex max-w-4xl gap-2">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="Ask about this document..."
                rows={1}
                className="min-h-[44px] resize-none"
              />
              <Button onClick={send} disabled={ask.isPending || !input.trim()}>
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Task output panel */}
        {taskOutput && (
          <aside className="hidden w-[480px] flex-shrink-0 overflow-y-auto border-l bg-muted/20 p-6 lg:block">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-lg font-semibold capitalize">
                {taskOutput.task.replace("_", " ")}
              </h3>
              <Button size="sm" variant="ghost" onClick={() => setTaskOutput(null)}>
                ×
              </Button>
            </div>
            <div className="prose prose-sm max-w-none text-foreground dark:prose-invert">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
              >
                {taskOutput.content}
              </ReactMarkdown>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
