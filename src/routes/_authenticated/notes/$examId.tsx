import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useRef, useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  FolderPlus, FilePlus, Folder, FileText, ArrowLeft,
  Trash2, Save, Eye, Edit3, Sparkles, Loader2,
  Check, Copy, Code2, CheckCircle2, AlertCircle,
  Type, BookOpen, ImagePlus,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import ResizeImage from "tiptap-extension-resize-image";
import { Markdown } from "tiptap-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { formatNoteWithAI } from "@/lib/ai.functions";

const unescapeMath = (math: string) => {
  let cleaned = math
    .replace(/\\\\/g, '\\') // Unescape backslashes
    .replace(/\\_/g, '_')   // Unescape underscores
    .replace(/\\\*/g, '*')  // Unescape asterisks
    .replace(/\\\{/g, '{')  // Unescape left brace
    .replace(/\\\}/g, '}')  // Unescape right brace
    .replace(/\\\[/g, '[')  // Unescape left bracket
    .replace(/\\\]/g, ']')  // Unescape right bracket
    .replace(/\\\^/g, '^'); // Unescape caret

  // Aggressively fix \\frac or similar double-escaped LaTeX commands
  cleaned = cleaned.replace(/\\\\([a-zA-Z])/g, '\\$1');
  
  // Fix KaTeX "Expected EOF, got \" error caused by Tiptap hard breaks
  cleaned = cleaned.replace(/\\\s*$/g, '');
  
  return cleaned;
};

const preprocessMath = (content: string) => {
  if (!content) return "";
  return content
    // Safely unescape existing $$ ... $$ blocks
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, p1) => `$$${unescapeMath(p1)}$$`)
    // Safely unescape existing $ ... $ blocks
    .replace(/(?<!\$)\$([^\$]+?)\$(?!\$)/g, (_, p1) => `$${unescapeMath(p1)}$`);
};

export const Route = createFileRoute("/_authenticated/notes/$examId")({
  component: NotesWorkspace,
});

/* ─────────────────────────────────────────────
   CodeBlock — fenced code with copy button
   (shared pattern from chat enhancement)
   ───────────────────────────────────────────── */
function CodeBlock({ language, children }: { language?: string; children: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [children]);

  const displayLang = language || "text";

  return (
    <div className="chat-code-block my-4 border border-border/40">
      <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.03] px-4 py-2">
        <div className="flex items-center gap-2 text-xs text-white/50">
          <Code2 className="h-3.5 w-3.5" />
          <span className="font-mono">{displayLang}</span>
        </div>
        <button
          onClick={copy}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-white/50 transition-all hover:bg-white/10 hover:text-white/80"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-400" />
              <span className="text-emerald-400">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-[0.8125rem] leading-relaxed">
        <code className="font-mono text-white/90">{children}</code>
      </pre>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Premium Markdown Components for Preview
   ───────────────────────────────────────────── */
const previewMarkdownComponents = {
  code: ({ className, children, ...props }: any) => {
    const match = /language-(\w+)/.exec(className || "");
    const content = String(children).replace(/\n$/, "");
    if (match || content.includes("\n")) {
      return <CodeBlock language={match?.[1]}>{content}</CodeBlock>;
    }
    return (
      <code
        className="rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[0.8125rem] text-primary dark:bg-primary/15"
        {...props}
      >
        {children}
      </code>
    );
  },

  h1: ({ children, ...props }: any) => (
    <h1
      className="mb-6 mt-10 border-b-2 border-primary/30 pb-4 font-display text-3xl font-extrabold tracking-tight text-foreground first:mt-0"
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: any) => (
    <h2
      className="mb-5 mt-9 border-l-4 border-primary/60 pl-4 font-display text-2xl font-bold tracking-tight text-foreground first:mt-0"
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: any) => (
    <h3
      className="mb-4 mt-7 border-l-4 border-gold/60 pl-4 font-display text-xl font-semibold tracking-tight text-foreground first:mt-0"
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...props }: any) => (
    <h4
      className="mb-3 mt-5 font-display text-lg font-bold text-foreground first:mt-0"
      {...props}
    >
      {children}
    </h4>
  ),

  p: ({ children, ...props }: any) => (
    <p className="mb-4 text-[0.9375rem] leading-[1.8] text-foreground/90 last:mb-0" {...props}>
      {children}
    </p>
  ),

  ul: ({ children, ...props }: any) => (
    <ul 
      className="mb-4 ml-1 space-y-2 last:mb-0 list-none [&>li]:relative [&>li]:pl-6 [&>li]:before:absolute [&>li]:before:left-1 [&>li]:before:top-[0.55rem] [&>li]:before:h-2 [&>li]:before:w-2 [&>li]:before:shrink-0 [&>li]:before:rounded-full [&>li]:before:bg-gradient-to-br [&>li]:before:from-primary/70 [&>li]:before:to-gold/70" 
      {...props}
    >
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: any) => (
    <ol className="mb-4 ml-1 list-decimal space-y-2 pl-5 last:mb-0 marker:text-primary/60 marker:font-bold" {...props}>
      {children}
    </ol>
  ),
  li: ({ className, children, ...props }: any) => (
    <li className={`text-[0.9375rem] leading-[1.7] ${className || ""}`} {...props}>
      {children}
    </li>
  ),

  blockquote: ({ children, ...props }: any) => (
    <blockquote
      className="my-5 rounded-xl border-l-4 border-primary/40 bg-gradient-to-r from-primary/5 to-transparent py-3 pl-5 pr-4 text-[0.9375rem] leading-[1.7] text-foreground/85 dark:from-primary/10"
      {...props}
    >
      {children}
    </blockquote>
  ),

  a: ({ children, ...props }: any) => (
    <a
      className="font-medium text-primary underline decoration-primary/30 underline-offset-2 transition-colors hover:decoration-primary/70"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),

  hr: () => (
    <div className="my-8 flex items-center gap-3">
      <div className="h-px flex-1 bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
      <div className="flex gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-primary/30" />
        <span className="h-1.5 w-1.5 rounded-full bg-gold/40" />
        <span className="h-1.5 w-1.5 rounded-full bg-primary/30" />
      </div>
      <div className="h-px flex-1 bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
    </div>
  ),

  strong: ({ children, ...props }: any) => (
    <strong className="font-bold text-foreground" {...props}>
      {children}
    </strong>
  ),

  em: ({ children, ...props }: any) => (
    <em className="text-foreground/75 not-italic font-medium" style={{ fontStyle: "italic" }} {...props}>
      {children}
    </em>
  ),

  table: ({ ...props }: any) => (
    <div className="my-6 overflow-x-auto rounded-xl border bg-card/50 shadow-sm">
      <table className="m-0 w-full text-sm" {...props} />
    </div>
  ),
  thead: ({ ...props }: any) => (
    <thead className="bg-muted/40" {...props} />
  ),
  th: ({ ...props }: any) => (
    <th
      className="border-b bg-muted/50 px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap"
      {...props}
    />
  ),
  td: ({ ...props }: any) => (
    <td className="border-b border-border/40 px-4 py-3 text-[0.875rem]" {...props} />
  ),
  tr: ({ ...props }: any) => (
    <tr className="transition-colors hover:bg-muted/20" {...props} />
  ),

  pre: ({ children, ...props }: any) => (
    <div {...props}>{children}</div>
  ),

  img: ({ src, alt, ...props }: any) => (
    <img
      src={src}
      alt={alt || ""}
      className="my-4 max-w-full rounded-xl border shadow-sm"
      loading="lazy"
      {...props}
    />
  ),
};

/* ─────────────────────────────────────────────
   Save Status types
   ───────────────────────────────────────────── */
type SaveStatus = "saved" | "saving" | "unsaved" | "idle";

/* ─────────────────────────────────────────────
   Main Component
   ───────────────────────────────────────────── */
function NotesWorkspace() {
  const { examId } = Route.useParams();
  const { user } = useAuth();
  const qc = useQueryClient();
  const formatFn = useServerFn(formatNoteWithAI);

  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [isPreview, setIsPreview] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  const [newFolderName, setNewFolderName] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedContent = useRef<string>("");

  const handleContentChange = useCallback(
    (newContent: string) => {
      setEditorContent(newContent);

      if (newContent !== lastSavedContent.current) {
        setSaveStatus("unsaved");
      }

      // Clear existing timer
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }

      // Set new timer
      if (activeNoteId && newContent !== lastSavedContent.current) {
        debounceTimer.current = setTimeout(() => {
          setSaveStatus("saving");
          saveNote.mutate({ id: activeNoteId, content: newContent });
        }, 1500);
      }
    },
    [activeNoteId, /* saveNote will be hoisted implicitly by React */],
  );

  const editor = useEditor({
    extensions: [
      StarterKit,
      Image,
      ResizeImage,
      Markdown.configure({
        html: true,
        tightLists: true,
        tightListClass: 'tight',
        bulletListMarker: '-',
        linkify: true,
        breaks: true,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: editorContent,
    onUpdate: ({ editor }) => {
      const md = (editor.storage as any).markdown.getMarkdown();
      handleContentChange(md);
    },
    editorProps: {
      attributes: {
        class: 'prose prose-sm md:prose-base dark:prose-invert max-w-none focus:outline-none w-full min-h-[500px]',
      },
      handleDOMEvents: {
        keydown: (_view, event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 's') {
            event.preventDefault();
            manualSave();
            return true;
          }
          return false;
        },
      },
    },
  });

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user || !examId) return;

    try {
      toast.loading("Uploading image...", { id: "upload-image" });
      const fileExt = file.name.split('.').pop();
      const fileName = `${Math.random().toString(36).substring(2)}-${Date.now()}.${fileExt}`;
      const filePath = `${user.id}/${examId}/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('note_images')
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('note_images')
        .getPublicUrl(filePath);

      editor?.chain().focus().setImage({ src: publicUrl }).run();
      toast.success("Image attached!", { id: "upload-image" });
    } catch (error: any) {
      toast.error(`Upload failed: ${error.message}`, { id: "upload-image" });
    }
    
    // Reset file input
    e.target.value = '';
  };

  // Fetch Exam
  const { data: exam } = useQuery({
    queryKey: ["exam", examId],
    queryFn: async () => {
      const { data } = await supabase.from("exams").select("*").eq("id", examId).single();
      return data;
    }
  });

  // Fetch Folders
  const { data: folders = [] } = useQuery({
    queryKey: ["folders", examId],
    queryFn: async () => {
      const { data } = await supabase.from("folders").select("*").eq("exam_id", examId).order("created_at");
      return data ?? [];
    }
  });

  // Fetch Notes
  const { data: notes = [] } = useQuery({
    queryKey: ["notes", examId],
    queryFn: async () => {
      const { data } = await supabase
        .from("documents")
        .select("*")
        .eq("exam_id", examId)
        .eq("doc_type", "notes")
        .order("created_at");
      return data ?? [];
    }
  });

  // Load content when note changes
  useEffect(() => {
    if (activeNoteId) {
      const note = notes.find((n) => n.id === activeNoteId);
      if (note) {
        setEditorContent(note.content || "");
        lastSavedContent.current = note.content || "";
        setSaveStatus("saved");
        if (editor) {
          const currentMd = (editor.storage as any).markdown.getMarkdown();
          if (note.content !== currentMd) {
            editor.commands.setContent(note.content || "");
          }
        }
      }
    } else {
      setEditorContent("");
      lastSavedContent.current = "";
      setSaveStatus("idle");
      if (editor) {
        editor.commands.setContent("");
      }
    }
  }, [activeNoteId, notes, editor]);

  // Mutations
  const createFolder = useMutation({
    mutationFn: async (name: string) => {
      if (!user) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("folders")
        .insert({ user_id: user.id, exam_id: examId, name })
        .select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["folders", examId] });
      setNewFolderName("");
      setIsCreatingFolder(false);
      toast.success("Folder created");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createNote = useMutation({
    mutationFn: async (folderId: string | null) => {
      if (!user) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("documents")
        .insert({
          user_id: user.id,
          exam_id: examId,
          folder_id: folderId,
          title: "Untitled Note",
          doc_type: "notes",
          content: ""
        })
        .select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["notes", examId] });
      if (data) {
        setActiveNoteId(data.id);
        setIsPreview(false);
      }
      toast.success("Note created");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveNote = useMutation({
    mutationFn: async ({ id, content }: { id: string, content: string }) => {
      // Extract title from first h1
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : "Untitled Note";

      const { error } = await supabase
        .from("documents")
        .update({ content, title })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      lastSavedContent.current = editorContent;
      setSaveStatus("saved");
      qc.invalidateQueries({ queryKey: ["notes", examId] });
    },
    onError: (e: Error) => {
      setSaveStatus("unsaved");
      toast.error(`Failed to save: ${e.message}`);
    },
  });

  const deleteNote = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("documents").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_, id) => {
      if (activeNoteId === id) {
        setActiveNoteId(null);
        setSaveStatus("idle");
      }
      qc.invalidateQueries({ queryKey: ["notes", examId] });
      toast.success("Note deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteFolder = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("folders").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_, id) => {
      if (activeFolderId === id) setActiveFolderId(null);
      qc.invalidateQueries({ queryKey: ["folders", examId] });
      toast.success("Folder deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // AI Format
  const aiFormat = useMutation({
    mutationFn: async (noteId: string) => {
      return formatFn({ data: { noteId } });
    },
    onSuccess: (result) => {
      if (result.formatted) {
        setEditorContent(result.formatted);
        lastSavedContent.current = result.formatted;
        setSaveStatus("saved");
        if (editor) {
          editor.commands.setContent(result.formatted);
        }
      }
      qc.invalidateQueries({ queryKey: ["notes", examId] });
      toast.success("Notes formatted by AI!");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // useCallback moved to top

  // Manual save
  const manualSave = useCallback(() => {
    if (!activeNoteId) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    setSaveStatus("saving");
    saveNote.mutate({ id: activeNoteId, content: editorContent });
  }, [activeNoteId, editorContent, saveNote]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // Word count
  const wordCount = editorContent.trim() ? editorContent.trim().split(/\s+/).length : 0;

  // Organizing notes by folder
  const unassignedNotes = notes.filter((n) => !n.folder_id);

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      {/* ── Sidebar Navigation ── */}
      <aside className="flex w-72 flex-col border-r bg-card h-full flex-shrink-0">
        <div className="border-b p-4">
          <Link to="/notes" className="flex items-center text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to Notebooks
          </Link>
          <h2 className="font-display text-lg font-bold line-clamp-1">{exam?.subject || "Loading..."}</h2>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {/* Folders List */}
          <div>
            <div className="flex items-center justify-between px-2 mb-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Chapters</h3>
              <button
                onClick={() => setIsCreatingFolder(!isCreatingFolder)}
                className="text-muted-foreground hover:text-primary transition-colors p-1 rounded hover:bg-muted"
                title="New Chapter Folder"
              >
                <FolderPlus className="h-4 w-4" />
              </button>
            </div>

            {isCreatingFolder && (
              <div className="px-2 mb-2 flex gap-2">
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="Chapter Name..."
                  className="w-full text-sm rounded bg-background border px-2 py-1 outline-none focus:border-primary"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newFolderName.trim()) createFolder.mutate(newFolderName.trim());
                    if (e.key === 'Escape') setIsCreatingFolder(false);
                  }}
                  autoFocus
                />
              </div>
            )}

            <div className="space-y-1">
              {folders.map(folder => (
                <div key={folder.id} className="space-y-0.5">
                  <div className="group flex items-center justify-between rounded-lg px-2 py-1.5 text-sm hover:bg-muted/50 transition-colors">
                    <div
                      className="flex items-center gap-2 cursor-pointer flex-1"
                      onClick={() => setActiveFolderId(activeFolderId === folder.id ? null : folder.id)}
                    >
                      <Folder className={`h-4 w-4 ${activeFolderId === folder.id ? "text-primary fill-primary/20" : "text-muted-foreground"}`} />
                      <span className="font-medium truncate">{folder.name}</span>
                    </div>
                    <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity gap-1">
                      <button onClick={() => createNote.mutate(folder.id)} title="Add Note">
                        <FilePlus className="h-3.5 w-3.5 text-muted-foreground hover:text-primary" />
                      </button>
                      <button onClick={() => { if(confirm('Delete folder and all its notes?')) deleteFolder.mutate(folder.id) }} title="Delete Folder">
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                      </button>
                    </div>
                  </div>

                  {/* Notes inside this folder */}
                  {activeFolderId === folder.id && (
                    <div className="pl-6 space-y-0.5 border-l-2 border-border/50 ml-3.5 my-1">
                      {notes.filter(n => n.folder_id === folder.id).map(note => (
                        <div
                          key={note.id}
                          onClick={() => setActiveNoteId(note.id)}
                          className={`group flex items-center justify-between rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors ${
                            activeNoteId === note.id ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                          }`}
                        >
                          <div className="flex items-center gap-2 truncate">
                            <FileText className="h-3.5 w-3.5 flex-shrink-0" />
                            <span className="truncate">{note.title || "Untitled"}</span>
                          </div>
                          <button
                            className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-destructive"
                            onClick={(e) => { e.stopPropagation(); deleteNote.mutate(note.id); }}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                      {notes.filter(n => n.folder_id === folder.id).length === 0 && (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground/60 italic">No notes yet</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="pt-4 mt-4 border-t">
            <div className="flex items-center justify-between px-2 mb-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Uncategorized Notes</h3>
              <button
                onClick={() => createNote.mutate(null)}
                className="text-muted-foreground hover:text-primary transition-colors p-1 rounded hover:bg-muted"
                title="New Note"
              >
                <FilePlus className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-0.5">
              {unassignedNotes.map(note => (
                <div
                  key={note.id}
                  onClick={() => setActiveNoteId(note.id)}
                  className={`group flex items-center justify-between rounded-lg px-2 py-1.5 text-sm cursor-pointer transition-colors ${
                    activeNoteId === note.id ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <FileText className={`h-4 w-4 flex-shrink-0 ${activeNoteId === note.id ? "text-primary" : "text-muted-foreground"}`} />
                    <span className="truncate">{note.title || "Untitled"}</span>
                  </div>
                  <button
                    className="opacity-0 group-hover:opacity-100 p-1 hover:text-destructive transition-opacity"
                    onClick={(e) => { e.stopPropagation(); deleteNote.mutate(note.id); }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>

      {/* ── Main Editor Area ── */}
      <main className="flex-1 flex flex-col h-full bg-background min-w-0">
        {activeNoteId ? (
          <>
            {/* ── Editor Header ── */}
            <header className="flex items-center justify-between border-b bg-card px-6 py-3 shrink-0">
              <div className="flex items-center gap-3">
                {/* Write / Preview toggle */}
                <div className="flex items-center rounded-xl border bg-muted/30 p-0.5">
                  <button
                    onClick={() => setIsPreview(false)}
                    className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
                      !isPreview
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Edit3 className="h-3.5 w-3.5" /> Write
                  </button>
                  <button
                    onClick={() => setIsPreview(true)}
                    className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
                      isPreview
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Eye className="h-3.5 w-3.5" /> Preview
                  </button>
                </div>

                {/* Save status indicator */}
                <div className="flex items-center gap-1.5 text-xs">
                  {saveStatus === "saved" && (
                    <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Saved
                    </span>
                  )}
                  {saveStatus === "saving" && (
                    <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving...
                    </span>
                  )}
                  {saveStatus === "unsaved" && (
                    <span className="flex items-center gap-1 text-orange-600 dark:text-orange-400">
                      <AlertCircle className="h-3.5 w-3.5" /> Unsaved
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                {/* Word count */}
                <span className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground">
                  <Type className="h-3 w-3" /> {wordCount} words
                </span>

                {/* Image Upload */}
                {!isPreview && (
                  <>
                    <input 
                      type="file" 
                      accept="image/*" 
                      className="hidden" 
                      id="image-upload" 
                      onChange={handleImageUpload} 
                    />
                    <label 
                      htmlFor="image-upload" 
                      className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3 gap-1.5 cursor-pointer"
                      title="Attach Image"
                    >
                      <ImagePlus className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Image</span>
                    </label>
                  </>
                )}

                {/* AI Format button */}
                <Button
                  onClick={() => activeNoteId && aiFormat.mutate(activeNoteId)}
                  disabled={aiFormat.isPending || !editorContent.trim()}
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  title="AI will restructure your notes into clean, exam-ready markdown"
                >
                  {aiFormat.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 text-primary" />
                  )}
                  <span className="hidden sm:inline">{aiFormat.isPending ? "Formatting..." : "Format with AI"}</span>
                </Button>

                {/* Manual save */}
                <Button
                  onClick={manualSave}
                  disabled={saveNote.isPending || saveStatus === "saved"}
                  size="sm"
                  className="gap-1.5"
                >
                  <Save className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Save</span>
                </Button>
              </div>
            </header>

            {/* ── Editor / Preview Body ── */}
            <div className="flex-1 overflow-hidden relative">
              {/* ── Write Mode ── */}
              <div className={`w-full h-full overflow-y-auto bg-background p-8 ${isPreview ? 'hidden' : 'block'}`}>
                <div className="mx-auto max-w-3xl h-full">
                  <EditorContent editor={editor} />
                </div>
              </div>

              {/* ── Preview Mode — Premium Rendering ── */}
              <div className={`w-full h-full overflow-y-auto p-8 bg-gradient-to-b from-card/30 to-background ${!isPreview ? 'hidden' : 'block'}`}>
                <div className="mx-auto max-w-3xl">
                  {editorContent.trim() ? (
                    <article className="rounded-2xl border bg-card/80 p-8 shadow-sm backdrop-blur-sm md:p-10">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm, remarkMath]}
                          rehypePlugins={[rehypeRaw, rehypeKatex]}
                          components={previewMarkdownComponents}
                        >
                          {preprocessMath(editorContent)}
                        </ReactMarkdown>
                    </article>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50">
                        <Eye className="h-7 w-7 text-muted-foreground/40" />
                      </div>
                      <h3 className="font-display text-lg font-semibold text-muted-foreground">Nothing to preview</h3>
                      <p className="mt-1 text-sm text-muted-foreground/60">
                        Switch to Write mode and add some content first.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── Status Bar ── */}
            <div className="flex items-center justify-between border-t bg-card/50 px-6 py-1.5 text-[0.6875rem] text-muted-foreground/50">
              <span>
                <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[0.625rem]">Ctrl+S</kbd> to save
              </span>
              <span>Markdown supported</span>
            </div>
          </>
        ) : (
          /* ── No note selected ── */
          <div className="flex h-full flex-col items-center justify-center text-center p-8 bg-muted/10">
            <div className="chat-sparkle-float mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-gold/20 shadow-lg shadow-primary/5">
              <BookOpen className="h-8 w-8 text-primary" />
            </div>
            <h2 className="font-display text-2xl font-bold">Select or Create a Note</h2>
            <p className="mt-2 text-muted-foreground max-w-sm">
              Use the sidebar to create a chapter folder or a standalone note for this exam.
            </p>
            <Button onClick={() => createNote.mutate(null)} className="mt-6 gap-2">
              <FilePlus className="h-4 w-4" /> Create Note
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
