import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useRef, useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { Send, Sparkles, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { chatWithDoc } from "@/lib/ai.functions";

export const Route = createFileRoute("/_authenticated/chat")({
  component: GeneralChat,
});

function GeneralChat() {
  const qc = useQueryClient();
  const chat = useServerFn(chatWithDoc);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const { data: messages = [] } = useQuery({
    queryKey: ["messages", "general"],
    queryFn: async () => {
      const { data } = await supabase
        .from("chat_messages")
        .select("*")
        .is("document_id", null)
        .order("created_at", { ascending: true });
      return data ?? [];
    },
  });

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const ask = useMutation({
    mutationFn: async (q: string) => chat({ data: { documentId: null, question: q } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["messages", "general"] }),
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
        <h1 className="font-display text-2xl font-semibold">AI Tutor</h1>
        <p className="text-sm text-muted-foreground">Ask anything — concepts, explanations, study help.</p>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {!messages.length && (
          <div className="mx-auto max-w-md rounded-2xl border bg-card p-6 text-center">
            <Sparkles className="mx-auto h-6 w-6 text-primary" />
            <h3 className="mt-3 font-semibold">Start a conversation</h3>
            <p className="mt-1 text-sm text-muted-foreground">Try: "Explain integration by parts simply" or "Quiz me on photosynthesis."</p>
          </div>
        )}
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.map((m) => (
            <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                  m.role === "user" ? "bg-primary text-primary-foreground" : "bg-card border"
                }`}
              >
                {m.role === "user" ? (
                  <div className="whitespace-pre-wrap">{m.content}</div>
                ) : (
                  <div className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown>{m.content}</ReactMarkdown></div>
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
        <div className="mx-auto flex max-w-3xl gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Ask the AI tutor anything..."
            rows={1}
            className="min-h-[44px] resize-none"
          />
          <Button onClick={send} disabled={ask.isPending || !input.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
