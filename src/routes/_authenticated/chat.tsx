import { createFileRoute } from "@tanstack/react-router";
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
  Sparkles,
  Loader2,
  Pencil,
  MessageSquare,
  X,
  Copy,
  Check,
  Code2,
  Bot,
  User,
  ArrowUp,
  Lightbulb,
  BookOpen,
  Calendar,
  Target,
  Menu,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { chatInThread, generateThreadTitle, editAndResend } from "@/lib/ai.functions";

export const Route = createFileRoute("/_authenticated/chat")({
  component: GeneralChat,
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

// Helper for date grouping
function getDateGroup(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff <= 7) return "Previous 7 Days";
  return "Older";
}
const SUGGESTIONS = [
  { icon: Calendar, label: "What should I study today?" },
  { icon: Target, label: "Help me prioritize my exams" },
  { icon: BookOpen, label: "Create a study plan for this week" },
  { icon: Lightbulb, label: "Tips for better memorization" },
];

/* ─────────────────────────────────────────────
   Main Component
   ───────────────────────────────────────────── */
function GeneralChat() {
  const qc = useQueryClient();
  const chatFn = useServerFn(chatInThread);
  const titleFn = useServerFn(generateThreadTitle);
  const editFn = useServerFn(editAndResend);

  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Get current user
  const { data: user } = useQuery({
    queryKey: ["current-user"],
    queryFn: async () => {
      const { data } = await supabase.auth.getUser();
      return data.user;
    },
  });

  // Fetch threads for general chat (exam_id is null)
  const { data: threads = [] } = useQuery({
    queryKey: ["general-threads", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data } = await supabase
        .from("chat_threads")
        .select("*")
        .is("exam_id", null)
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false });
      return (data ?? []) as Thread[];
    },
    enabled: !!user,
  });

  // Auto-select first thread if none selected
  useEffect(() => {
    if (threads.length > 0 && !activeThreadId) {
      setActiveThreadId(threads[0].id);
    }
  }, [threads, activeThreadId]);

  // Fetch messages for active thread
  const { data: messages = [] } = useQuery({
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

  // Scroll to bottom
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 160) + "px";
    }
  }, [input]);

  // Create new thread
  const createThread = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("chat_threads")
        .insert({ user_id: user.id, title: "New Chat" }) // exam_id is null by default
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (thread) => {
      setActiveThreadId(thread.id);
      qc.invalidateQueries({ queryKey: ["general-threads", user?.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Send message
  const sendMessage = useMutation({
    mutationFn: async (question: string) => {
      if (!activeThreadId) throw new Error("No thread selected");
      return chatFn({ data: { threadId: activeThreadId, question } });
    },
    onSuccess: (_res, question) => {
      qc.invalidateQueries({ queryKey: ["thread-messages", activeThreadId] });
      qc.invalidateQueries({ queryKey: ["general-threads", user?.id] });
      // Auto-title
      if (messages.length === 0 && activeThreadId) {
        titleFn({ data: { threadId: activeThreadId, firstMessage: question } })
          .then(() => qc.invalidateQueries({ queryKey: ["general-threads", user?.id] }))
          .catch(() => {});
      }
    },
    onError: (e: Error) => toast.error(e.message),
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
      qc.invalidateQueries({ queryKey: ["general-threads", user?.id] });
      toast.success("Thread deleted");
    },
  });

  // Edit and resend
  const editMessage = useMutation({
    mutationFn: async ({ messageId, newContent }: { messageId: string; newContent: string }) => {
      if (!activeThreadId) throw new Error("No thread");
      return editFn({
        data: { messageId, threadId: activeThreadId, examId: null, newContent },
      });
    },
    onSuccess: () => {
      setEditingId(null);
      setEditText("");
      qc.invalidateQueries({ queryKey: ["thread-messages", activeThreadId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const send = useCallback(() => {
    const q = input.trim();
    if (!q || !activeThreadId) return;
    setInput("");
    sendMessage.mutate(q);
  }, [input, activeThreadId, sendMessage]);

  const sendSuggestion = useCallback(
    (text: string) => {
      if (!activeThreadId) return;
      sendMessage.mutate(text);
    },
    [activeThreadId, sendMessage]
  );

  // Group threads
  const groupedThreads = threads.reduce((acc, t) => {
    const group = getDateGroup(t.updated_at);
    if (!acc[group]) acc[group] = [];
    acc[group].push(t);
    return acc;
  }, {} as Record<string, Thread[]>);

  const groups = ["Today", "Yesterday", "Previous 7 Days", "Older"].filter(
    (g) => groupedThreads[g]?.length > 0
  );

  const sidebarContent = (
    <>
      <div className="border-b px-4 py-4 flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
          <Sparkles className="h-4 w-4 text-primary" />
        </div>
        <h2 className="font-display text-lg font-semibold">General Assistant</h2>
      </div>

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

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {threads.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No conversations yet
          </p>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <div key={group}>
                <h3 className="px-3 mb-2 text-xs font-medium text-muted-foreground">
                  {group}
                </h3>
                <div className="space-y-0.5">
                  {groupedThreads[group].map((t) => (
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
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className="flex h-full">
      {/* ── Left Sidebar (Desktop) ── */}
      {sidebarOpen && (
        <aside className="hidden md:flex w-72 flex-col border-r bg-card">
          {sidebarContent}
        </aside>
      )}

      {/* ── Right Panel ── */}
      <div className="flex flex-1 flex-col min-w-0">
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
              {activeThreadId
                ? threads.find((t) => t.id === activeThreadId)?.title ?? "Chat"
                : "General Chat"}
            </h1>
          </div>
        </header>

        {/* ── Messages Area ── */}
        <div className="flex-1 overflow-y-auto">
          {!activeThreadId ? (
            /* ── No thread selected ── */
            <div className="flex h-full items-center justify-center p-4">
              <div className="mx-auto max-w-lg text-center">
                <div className="chat-sparkle-float mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-gold/20 shadow-lg shadow-primary/5">
                  <Sparkles className="h-8 w-8 text-primary" />
                </div>
                <h3 className="font-display text-2xl font-semibold tracking-tight">
                  Start a new conversation
                </h3>
                <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
                  Ask the General Assistant about your study schedule.
                  <br />
                  <br />
                  <strong>Note:</strong> To chat about your uploaded PDFs, go to the{" "}
                  <strong>Exams</strong> tab and click <strong>Study Space</strong> on a specific
                  exam.
                </p>
                <Button onClick={() => createThread.mutate()} className="mt-6" size="sm">
                  <Plus className="mr-2 h-4 w-4" /> New Chat
                </Button>
              </div>
            </div>
          ) : !messages.length && !sendMessage.isPending ? (
            /* ── Empty thread — suggestions ── */
            <div className="flex h-full items-center justify-center p-4">
              <div className="mx-auto max-w-xl text-center">
                <div className="chat-sparkle-float mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-gold/20 shadow-lg shadow-primary/5">
                  <Sparkles className="h-8 w-8 text-primary" />
                </div>
                <h3 className="font-display text-2xl font-semibold tracking-tight">
                  How can I help you plan?
                </h3>
                <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
                  To chat about your PDFs, use the <strong>Study Space</strong> button on the Exams
                  tab.
                </p>

                {/* Suggestion chips */}
                <div className="mx-auto mt-8 grid max-w-md grid-cols-1 gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s.label}
                      onClick={() => sendSuggestion(s.label)}
                      className="chat-suggestion-chip flex items-center gap-2.5 rounded-xl border bg-card px-4 py-3 text-left text-sm text-foreground/80"
                    >
                      <s.icon className="h-4 w-4 shrink-0 text-primary/60" />
                      <span>{s.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            /* ── Message list ── */
            <div className="mx-auto max-w-4xl space-y-1 px-4 py-6 md:px-6">
              {messages.map((m, idx) => (
                <div
                  key={m.id}
                  className="chat-message-enter"
                  style={{ animationDelay: `${Math.min(idx * 30, 300)}ms` }}
                >
                  {m.role === "user" ? (
                    /* ── User Message ── */
                    <div className="group flex justify-end py-2">
                      {editingId === m.id ? (
                        <div className="w-full max-w-[85%] space-y-2">
                          <Textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            rows={3}
                            className="resize-none rounded-xl"
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
                                editMessage.mutate({
                                  messageId: m.id,
                                  newContent: editText.trim(),
                                })
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
                        <div className="relative flex items-start gap-3">
                          {/* Edit button */}
                          <button
                            className="mt-2 shrink-0 rounded-lg p-1.5 opacity-0 transition-all group-hover:opacity-100 hover:bg-muted"
                            onClick={() => {
                              setEditingId(m.id);
                              setEditText(m.content);
                            }}
                            title="Edit message"
                          >
                            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                          </button>
                          {/* Bubble */}
                          <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-sm leading-relaxed text-primary-foreground shadow-sm">
                            <div className="whitespace-pre-wrap">{m.content}</div>
                          </div>
                          {/* Avatar */}
                          <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
                            <User className="h-3.5 w-3.5 text-primary" />
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    /* ── Assistant Message ── */
                    <div className="group flex gap-3 py-3">
                      {/* Avatar */}
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-gold/20">
                        <Bot className="h-3.5 w-3.5 text-primary" />
                      </div>
                      {/* Content */}
                      <div className="chat-assistant-accent min-w-0 flex-1 rounded-2xl rounded-tl-md border bg-card/80 px-5 py-4 shadow-sm backdrop-blur-sm">
                        <div className="prose prose-sm max-w-none text-foreground dark:prose-invert">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={markdownComponents}
                          >
                            {m.content}
                          </ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {/* ── Thinking indicator ── */}
              {sendMessage.isPending && (
                <div className="chat-message-enter flex gap-3 py-3">
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-gold/20">
                    <Bot className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <div className="flex items-center gap-3 rounded-2xl rounded-tl-md border bg-card/80 px-5 py-4 shadow-sm backdrop-blur-sm">
                    <div className="chat-dot-pulse flex gap-1.5">
                      <span />
                      <span />
                      <span />
                    </div>
                    <span className="chat-shimmer text-xs font-medium">Thinking</span>
                  </div>
                </div>
              )}

              <div ref={endRef} />
            </div>
          )}
        </div>

        {/* ── Input Area ── */}
        {activeThreadId && (
          <div className="border-t bg-gradient-to-t from-background to-background/80 p-4 backdrop-blur-sm">
            <div className="chat-input-glow mx-auto flex max-w-4xl items-end gap-2 rounded-2xl border bg-card/90 p-2 shadow-sm backdrop-blur-sm">
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="Ask the AI tutor anything..."
                rows={1}
                className="min-h-[40px] max-h-[160px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
              />
              <Button
                onClick={send}
                disabled={sendMessage.isPending || !input.trim()}
                size="icon"
                className="h-9 w-9 shrink-0 rounded-xl"
              >
                {sendMessage.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowUp className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="mt-2 text-center text-[0.6875rem] text-muted-foreground/50">
              Press <kbd className="rounded bg-muted px-1 py-0.5 text-[0.625rem] font-mono">Enter</kbd> to send · <kbd className="rounded bg-muted px-1 py-0.5 text-[0.625rem] font-mono">Shift+Enter</kbd> for new line
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
