import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useRef, useEffect, useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "@/components/ui/markdown";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Send,
  ArrowLeft,
  Sparkles,
  Loader2,
  Pencil,
  MessageSquare,
  X,
  BookOpen,
  Menu,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { chatInExamSpace, generateThreadTitle, editAndResend } from "@/lib/ai.functions";

export const Route = createFileRoute("/_authenticated/exams_/$id")({
  component: ExamChatPage,
});

type Thread = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

/* ------------------------------------------------------------------ */
/*  Exam Chat Page                                                     */
/* ------------------------------------------------------------------ */
function ExamChatPage() {
  const { id: examId } = Route.useParams();
  const qc = useQueryClient();
  const chatFn = useServerFn(chatInExamSpace);
  const titleFn = useServerFn(generateThreadTitle);
  const editFn = useServerFn(editAndResend);

  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const [streamingMessage, setStreamingMessage] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  // Reset stream state on thread switch
  useEffect(() => {
    setStreamingMessage("");
    setIsStreaming(false);
  }, [activeThreadId]);

  // Fetch exam info
  const { data: exam } = useQuery({
    queryKey: ["exam-detail", examId],
    queryFn: async () => {
      const { data } = await supabase
        .from("exams")
        .select("id, subject, exam_date, priority")
        .eq("id", examId)
        .single();
      return data;
    },
  });

  // Fetch threads for this exam
  const { data: threads = [] } = useQuery({
    queryKey: ["exam-threads", examId],
    queryFn: async () => {
      const { data } = await supabase
        .from("chat_threads")
        .select("*")
        .eq("exam_id", examId)
        .order("updated_at", { ascending: false });
      return (data ?? []) as Thread[];
    },
  });

  // Fetch document count for this exam
  const { data: docCount = 0 } = useQuery({
    queryKey: ["exam-doc-count", examId],
    queryFn: async () => {
      const { count } = await supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("exam_id", examId);
      return count ?? 0;
    },
  });

  // Auto-select first thread
  useEffect(() => {
    if (threads.length > 0 && !activeThreadId) {
      setActiveThreadId(threads[0].id);
    }
  }, [threads, activeThreadId]);

  // Fetch messages for active thread
  const { data: messages = [], isPending: messagesPending } = useQuery({
    queryKey: ["thread-messages", activeThreadId],
    queryFn: async () => {
      if (!activeThreadId) return [];
      const { data } = await supabase
        .from("chat_messages")
        .select("*")
        .eq("thread_id", activeThreadId)
        .order("created_at", { ascending: false })
        .limit(20);
      return ((data ?? []) as Message[]).reverse();
    },
    enabled: !!activeThreadId,
  });

  // Scroll to bottom on new messages
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingMessage]);


  // Create new thread
  const createThread = useMutation({
    mutationFn: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("chat_threads")
        .insert({ user_id: user.id, exam_id: examId, title: "New Chat" })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (thread) => {
      setActiveThreadId(thread.id);
      qc.invalidateQueries({ queryKey: ["exam-threads", examId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Send message
  const sendMessage = useMutation({
    mutationFn: async (question: string) => {
      if (!activeThreadId) throw new Error("No thread selected");
      setIsStreaming(true);
      setStreamingMessage("");
      try {
        const stream = await chatFn({ data: { examId, threadId: activeThreadId, question } });
        let currentResponse = "";
        for await (const chunk of stream) {
          currentResponse += chunk;
          setStreamingMessage(currentResponse);
        }
        return currentResponse;
      } finally {
        setIsStreaming(false);
      }
    },
    onSuccess: (_res, question) => {
      qc.invalidateQueries({ queryKey: ["thread-messages", activeThreadId] });
      qc.invalidateQueries({ queryKey: ["exam-threads", examId] });
      // Auto-title after first message
      if (messages.length === 0 && activeThreadId) {
        titleFn({ data: { threadId: activeThreadId, firstMessage: question } })
          .then(() => qc.invalidateQueries({ queryKey: ["exam-threads", examId] }))
          .catch(() => {});
      }
      setInput("");
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => {
      setStreamingMessage("");
      setIsStreaming(false);
    }
  });

  // Delete thread
  const deleteThread = useMutation({
    mutationFn: async (threadId: string) => {
      const { error } = await supabase.from("chat_threads").delete().eq("id", threadId);
      if (error) throw error;
    },
    onSuccess: (_res, threadId) => {
      if (activeThreadId === threadId) {
        const remaining = threads.filter((t) => t.id !== threadId);
        setActiveThreadId(remaining.length > 0 ? remaining[0].id : null);
      }
      qc.invalidateQueries({ queryKey: ["exam-threads", examId] });
      toast.success("Thread deleted");
    },
  });

  const editMessage = useMutation({
    mutationFn: async ({ messageId, newContent }: { messageId: string; newContent: string }) => {
      if (!activeThreadId) throw new Error("No thread");
      setIsStreaming(true);
      setStreamingMessage("");
      try {
        const stream = await editFn({
          data: { messageId, threadId: activeThreadId, examId, newContent },
        });
        let currentResponse = "";
        for await (const chunk of stream) {
          currentResponse += chunk;
          setStreamingMessage(currentResponse);
        }
        return currentResponse;
      } finally {
        setIsStreaming(false);
      }
    },
    onSuccess: () => {
      setEditingId(null);
      setEditText("");
      qc.invalidateQueries({ queryKey: ["thread-messages", activeThreadId] });
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => {
      setStreamingMessage("");
      setIsStreaming(false);
    }
  });

  const send = useCallback(() => {
    const q = input.trim();
    if (!q || !activeThreadId) return;
    setInput("");
    sendMessage.mutate(q);
  }, [input, activeThreadId, sendMessage]);

  const days = exam
    ? Math.ceil((new Date(exam.exam_date).getTime() - Date.now()) / 86_400_000)
    : 0;

  const sidebarContent = (
    <>
      {/* Sidebar Header */}
      <div className="border-b px-4 py-4">
        <Link
          to="/exams"
          className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3 w-3" /> Back to exams
        </Link>
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <BookOpen className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-sm font-semibold truncate">
              {exam?.subject ?? "Loading..."}
            </h2>
            {exam && (
              <p className="text-[11px] text-muted-foreground">
                {days >= 0 ? `${days}d left` : "Past"} · {docCount} docs
              </p>
            )}
          </div>
        </div>
      </div>

      {/* New Chat Button */}
      <div className="px-3 py-3">
        <Button
          onClick={() => createThread.mutate()}
          disabled={createThread.isPending}
          className="w-full justify-start gap-2"
          variant="outline"
          size="sm"
        >
          <Plus className="h-4 w-4" />
          New Chat
        </Button>
      </div>

      {/* Thread List */}
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {threads.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No conversations yet
          </p>
        ) : (
          <div className="space-y-0.5">
            {threads.map((t) => (
              <div
                key={t.id}
                className={`group flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm cursor-pointer transition-all ${
                  activeThreadId === t.id
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-foreground/80 hover:bg-muted/50"
                }`}
                onClick={() => setActiveThreadId(t.id)}
              >
                <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-50" />
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <button
                  className="shrink-0 rounded-md p-1 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteThread.mutate(t.id);
                  }}
                  title="Delete thread"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className="flex h-full">
      {/* ---- Left Sidebar (Desktop) ---- */}
      {sidebarOpen && (
        <aside className="hidden md:flex w-72 flex-col border-r bg-card">
          {sidebarContent}
        </aside>
      )}

      {/* ---- Right Panel ---- */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Mobile header */}
        <header className="flex items-center gap-3 border-b bg-card px-4 py-3 md:px-6 shrink-0">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden shrink-0">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0 flex flex-col">
              {sidebarContent}
            </SheetContent>
          </Sheet>

          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="hidden md:flex rounded-lg p-1.5 hover:bg-muted transition-colors shrink-0"
            title="Toggle sidebar"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-lg font-semibold truncate">
              {exam?.subject ?? "Study Space"}
            </h1>
            <p className="text-xs text-muted-foreground">
              {activeThreadId
                ? threads.find((t) => t.id === activeThreadId)?.title ?? "Chat"
                : "Select or start a chat"}
            </p>
          </div>
        </header>

        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6">
          {!activeThreadId ? (
            <div className="mx-auto max-w-md rounded-2xl border bg-card p-8 text-center mt-12">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <Sparkles className="h-6 w-6 text-primary" />
              </div>
              <h3 className="font-display text-lg font-semibold">Welcome to your Study Space</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Create a new chat to start studying {exam?.subject ?? ""}. The AI tutor will only
                use documents uploaded to this exam.
              </p>
              <Button onClick={() => createThread.mutate()} className="mt-4" size="sm">
                <Plus className="mr-2 h-4 w-4" /> Start a Chat
              </Button>
            </div>
          ) : messagesPending ? (
            <div className="flex h-full items-center justify-center p-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary/50" />
            </div>
          ) : !messages.length && !sendMessage.isPending ? (
            <div className="mx-auto max-w-md rounded-2xl border bg-card p-8 text-center mt-12">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <BookOpen className="h-6 w-6 text-primary" />
              </div>
              <h3 className="font-display text-lg font-semibold">
                Ask about {exam?.subject ?? "your exam"}
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {docCount > 0
                  ? `The AI has access to ${docCount} document${docCount > 1 ? "s" : ""} from this exam. Ask anything!`
                  : "Upload some notes or PDFs to this exam first, then come back to chat."}
              </p>
            </div>
          ) : (
            <div className="mx-auto max-w-4xl space-y-4">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`group flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  {m.role === "user" && editingId === m.id ? (
                    /* Edit mode */
                    <div className="w-full max-w-[85%] space-y-2">
                      <Textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={3}
                        className="resize-none"
                        autoFocus
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingId(null);
                            setEditText("");
                          }}
                        >
                          <X className="mr-1 h-3 w-3" /> Cancel
                        </Button>
                        <Button
                          size="sm"
                          disabled={editMessage.isPending || !editText.trim()}
                          onClick={() =>
                            editMessage.mutate({ messageId: m.id, newContent: editText.trim() })
                          }
                        >
                          {editMessage.isPending ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <Send className="mr-1 h-3 w-3" />
                          )}
                          Resend
                        </Button>
                      </div>
                    </div>
                  ) : (
                    /* Normal message bubble */
                    <div className="relative">
                      <div
                        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                          m.role === "user"
                            ? "bg-primary text-primary-foreground"
                            : "bg-card border"
                        }`}
                      >
                        {m.role === "user" ? (
                          <div className="whitespace-pre-wrap">{m.content}</div>
                        ) : (
                          <div className="prose prose-sm max-w-none text-foreground dark:prose-invert">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                              {m.content}
                            </ReactMarkdown>
                          </div>
                        )}
                      </div>
                      {m.role === "user" && (
                        <button
                          className="absolute -left-8 top-1/2 -translate-y-1/2 rounded-md p-1 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted"
                          onClick={() => {
                            setEditingId(m.id);
                            setEditText(m.content);
                          }}
                          title="Edit message"
                        >
                          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {/* ── Pending User Message ── */}
              {sendMessage.isPending && sendMessage.variables && (
                <div className="group flex justify-end">
                  <div className="relative">
                    <div className="max-w-[85%] rounded-2xl px-4 py-3 text-sm bg-primary text-primary-foreground opacity-60">
                      <div className="whitespace-pre-wrap">{sendMessage.variables}</div>
                    </div>
                  </div>
                </div>
              )}
              {/* ── Streaming or Thinking Assistant Message ── */}
              {(sendMessage.isPending || editMessage.isPending) && (
                <div className="flex gap-3 py-3">
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-gold/20">
                    <Bot className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <div className="chat-assistant-accent min-w-0 flex-1 rounded-2xl rounded-tl-md border bg-card/80 px-5 py-4 shadow-sm backdrop-blur-sm">
                    {streamingMessage ? (
                      <div className="prose prose-sm max-w-none text-foreground dark:prose-invert">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                          {streamingMessage}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <div className="chat-dot-pulse flex gap-1.5">
                          <span />
                          <span />
                          <span />
                        </div>
                        <span className="chat-shimmer text-xs font-medium">Thinking</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>

        {/* Input Area */}
        {activeThreadId && (
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
                placeholder={`Ask about ${exam?.subject ?? "this exam"}...`}
                rows={1}
                className="min-h-[44px] resize-none"
              />
              <Button
                onClick={send}
                disabled={sendMessage.isPending || !input.trim()}
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
