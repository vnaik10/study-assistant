import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "@/components/ui/markdown";
import {
  Plus,
  Trash2,
  Sparkles,
  Loader2,
  Pencil,
  Upload,
  FileText,
  Image as ImageIcon,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  X,
  Check,
  Copy,
  Code2,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { generateStudyPlan } from "@/lib/ai.functions";
import { extractPdfText } from "@/lib/pdf";

export const Route = createFileRoute("/_authenticated/exams")({
  component: ExamsPage,
});

type Exam = {
  id: string;
  subject: string;
  exam_date: string;
  priority: "low" | "medium" | "high";
  notes: string | null;
  question_pattern: string | null;
  study_plan: string | null;
};

type ExamDoc = {
  id: string;
  title: string;
  doc_type: string;
  created_at: string;
};

/* ------------------------------------------------------------------ */
/*  Exam Form (shared between Add & Edit dialogs)                     */
/* ------------------------------------------------------------------ */
function ExamForm({
  defaultValues,
  onSubmit,
  isPending,
  submitLabel,
}: {
  defaultValues?: Partial<Exam>;
  onSubmit: (form: { subject: string; exam_date: string; priority: string; notes: string; question_pattern: string }) => void;
  isPending: boolean;
  submitLabel: string;
}) {
  const [priority, setPriority] = useState<string>(defaultValues?.priority ?? "medium");

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        onSubmit({
          subject: String(fd.get("subject") || ""),
          exam_date: String(fd.get("exam_date") || ""),
          priority,
          notes: String(fd.get("notes") || ""),
          question_pattern: String(fd.get("question_pattern") || ""),
        });
      }}
    >
      <div>
        <Label htmlFor="exam-subject">Subject</Label>
        <Input
          id="exam-subject"
          name="subject"
          defaultValue={defaultValues?.subject ?? ""}
          required
        />
      </div>
      <div>
        <Label htmlFor="exam-date">Date</Label>
        <Input
          id="exam-date"
          name="exam_date"
          type="date"
          defaultValue={defaultValues?.exam_date ?? ""}
          required
        />
      </div>
      <div>
        <Label>Priority</Label>
        <Select value={priority} onValueChange={setPriority}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
          </SelectContent>
        </Select>
        {/* hidden input so FormData picks it up if needed */}
        <input type="hidden" name="priority" value={priority} />
      </div>
      <div>
        <Label htmlFor="exam-question-pattern">Question Paper Pattern (Optional)</Label>
        <Textarea
          id="exam-question-pattern"
          name="question_pattern"
          placeholder="e.g. 5 Modules, 20 marks each, internal choice between 2 questions per module..."
          defaultValue={defaultValues?.question_pattern ?? ""}
          rows={3}
        />
        <p className="mt-1 text-[0.8rem] text-muted-foreground">
          AI will use this pattern to generate mock exams and study plans.
        </p>
      </div>
      <Button type="submit" className="w-full" disabled={isPending}>
        {submitLabel}
      </Button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Upload Material Dialog                                            */
/* ------------------------------------------------------------------ */
function UploadMaterialDialog({
  examId,
  examSubject,
  open,
  onOpenChange,
}: {
  examId: string;
  examSubject: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [uploading, setUploading] = useState(false);

  const addDoc = useMutation({
    mutationFn: async (form: {
      title: string;
      subject: string;
      doc_type: string;
      content: string;
      exam_id: string;
    }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");
      const { error } = await supabase.from("documents").insert({ ...form, user_id: user.id });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["exam-docs", examId] });
      qc.invalidateQueries({ queryKey: ["documents"] });
      onOpenChange(false);
      toast.success("Material uploaded");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const file = fd.get("file") as File | null;
    let content = String(fd.get("content") || "");
    let title = String(fd.get("title") || "");
    const docType = String(fd.get("doc_type") || "notes");

    if (file && file.size > 0) {
      setUploading(true);
      try {
        if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
          content = await extractPdfText(file);
          if (!content.trim()) {
            content = `[Scanned PDF: ${file.name}] — No extractable text found.`;
            toast.info("Saved as reference. This seems to be a scanned PDF.");
          }
        } else if (file.type.startsWith("image/")) {
          // For images, store a placeholder note — actual OCR can be added later
          content = `[Image: ${file.name}] — Image uploaded as study material.`;
          toast.info("Image saved as reference. PDF upload recommended for text extraction.");
        } else {
          content = await file.text();
        }
        if (!title) title = file.name.replace(/\.[^.]+$/, "");
      } catch (err) {
        toast.error("Failed to read file: " + (err as Error).message);
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    if (!content.trim()) {
      toast.error("Add some content or upload a file");
      return;
    }
    addDoc.mutate({
      title: title || "Untitled",
      subject: examSubject,
      doc_type: docType,
      content,
      exam_id: examId,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload material — {examSubject}</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div>
            <Label htmlFor="upload-title">Title</Label>
            <Input id="upload-title" name="title" placeholder="(optional, autofills from file)" />
          </div>
          <div>
            <Label>Type</Label>
            <Select name="doc_type" defaultValue="notes">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="notes">Notes</SelectItem>
                <SelectItem value="pdf">PDF</SelectItem>
                <SelectItem value="past_paper">Previous Question Paper</SelectItem>
                <SelectItem value="assignment">Assignment</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="upload-file">Upload PDF or Image</Label>
            <Input
              id="upload-file"
              name="file"
              type="file"
              accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.webp"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Supported: PDF, TXT, MD, PNG, JPG, WEBP
            </p>
          </div>
          <div>
            <Label htmlFor="upload-content">Or paste content</Label>
            <Textarea
              id="upload-content"
              name="content"
              rows={4}
              placeholder="Paste notes or content..."
            />
          </div>
          <Button type="submit" className="w-full" disabled={addDoc.isPending || uploading}>
            {uploading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Extracting...
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" /> Upload
              </>
            )}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  Exam Card                                                         */
/* ------------------------------------------------------------------ */
function ExamCard({
  exam,
  onEdit,
  onDelete,
  onViewPlan,
}: {
  exam: Exam;
  onEdit: (e: Exam) => void;
  onDelete: (id: string) => void;
  onViewPlan: (e: Exam) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const { data: examDocs = [] } = useQuery({
    queryKey: ["exam-docs", exam.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("documents")
        .select("id, title, doc_type, created_at")
        .eq("exam_id", exam.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as ExamDoc[];
    },
  });

  const qc = useQueryClient();
  const delDoc = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("documents").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["exam-docs", exam.id] });
      qc.invalidateQueries({ queryKey: ["documents"] });
      toast.success("Material removed");
    },
  });

  const days = Math.ceil((new Date(exam.exam_date).getTime() - Date.now()) / 86_400_000);
  const priorityColor =
    exam.priority === "high"
      ? "bg-destructive/15 text-destructive"
      : exam.priority === "medium"
        ? "bg-gold/20 text-gold-foreground"
        : "bg-muted text-muted-foreground";

  const docTypeIcon = (t: string) => {
    if (t === "past_paper") return <FileText className="h-3.5 w-3.5 text-destructive" />;
    if (t === "pdf") return <FileText className="h-3.5 w-3.5 text-primary" />;
    if (t === "notes") return <FileText className="h-3.5 w-3.5 text-gold" />;
    return <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />;
  };

  return (
    <>
      <div className="rounded-2xl border bg-card p-5 shadow-elegant transition-shadow hover:shadow-lg">
        {/* Header row */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold">{exam.subject}</h3>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${priorityColor}`}>
                {exam.priority}
              </span>
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              {new Date(exam.exam_date).toLocaleDateString()} ·{" "}
              {days >= 0 ? `${days} days left` : "Past"}
            </div>
            {exam.notes && <p className="mt-2 text-sm">{exam.notes}</p>}
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button variant="default" size="sm" asChild>
              <Link to="/exams/$id" params={{ id: exam.id }}>
                <MessageSquare className="mr-1.5 h-3.5 w-3.5" /> Study Space
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => onViewPlan(exam)}>
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />{" "}
              {exam.study_plan ? "View plan" : "AI plan"}
            </Button>
            <Button variant="ghost" size="icon" title="Edit exam" onClick={() => onEdit(exam)}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Delete exam"
              onClick={() => onDelete(exam.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Materials section */}
        <div className="mt-4 border-t pt-3">
          <button
            type="button"
            className="flex w-full items-center justify-between text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setExpanded(!expanded)}
          >
            <span className="flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" />
              Notes & Question Papers
              {examDocs.length > 0 && (
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-semibold text-primary">
                  {examDocs.length}
                </span>
              )}
            </span>
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>

          {expanded && (
            <div className="mt-3 space-y-4">
              {examDocs.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No materials uploaded yet. Add notes or previous question papers for this exam.
                </p>
              ) : (
                <>
                  {/* Notes Section */}
                  {examDocs.filter((d) => d.doc_type !== "past_paper").length > 0 && (
                    <div className="space-y-1.5">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Notes & Reference Material
                      </h4>
                      {examDocs
                        .filter((d) => d.doc_type !== "past_paper")
                        .map((d) => (
                          <div
                            key={d.id}
                            className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm transition-colors hover:bg-muted/50"
                          >
                            {docTypeIcon(d.doc_type)}
                            <span className="min-w-0 flex-1 truncate font-medium">{d.title}</span>
                            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                              {d.doc_type.replace("_", " ")}
                            </span>
                            <Link to="/documents/$id" params={{ id: d.id }}>
                              <Button size="icon" variant="ghost" title="Open & chat">
                                <MessageSquare className="h-3.5 w-3.5" />
                              </Button>
                            </Link>
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Remove"
                              onClick={() => delDoc.mutate(d.id)}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                    </div>
                  )}

                  {/* Previous Question Papers Section */}
                  {examDocs.filter((d) => d.doc_type === "past_paper").length > 0 && (
                    <div className="space-y-1.5">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Previous Question Papers
                      </h4>
                      {examDocs
                        .filter((d) => d.doc_type === "past_paper")
                        .map((d) => (
                          <div
                            key={d.id}
                            className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm transition-colors hover:bg-muted/50"
                          >
                            {docTypeIcon(d.doc_type)}
                            <span className="min-w-0 flex-1 truncate font-medium">{d.title}</span>
                            <Link to="/documents/$id" params={{ id: d.id }}>
                              <Button size="icon" variant="ghost" title="Open & chat">
                                <MessageSquare className="h-3.5 w-3.5" />
                              </Button>
                            </Link>
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Remove"
                              onClick={() => delDoc.mutate(d.id)}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                    </div>
                  )}
                </>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 flex-1"
                  onClick={() => setUploadOpen(true)}
                >
                  <Upload className="mr-1.5 h-3.5 w-3.5" /> Upload Notes
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 flex-1"
                  onClick={() => setUploadOpen(true)}
                >
                  <Upload className="mr-1.5 h-3.5 w-3.5" /> Upload Past Paper
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <UploadMaterialDialog
        examId={exam.id}
        examSubject={exam.subject}
        open={uploadOpen}
        onOpenChange={setUploadOpen}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                         */
/* ------------------------------------------------------------------ */
function ExamsPage() {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [editExam, setEditExam] = useState<Exam | null>(null);
  const [planOf, setPlanOf] = useState<Exam | null>(null);
  const genPlan = useServerFn(generateStudyPlan);

  const { data: exams = [], isLoading } = useQuery({
    queryKey: ["exams"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exams")
        .select("*")
        .order("exam_date", { ascending: true });
      if (error) throw error;
      return data as Exam[];
    },
  });

  /* ---- Add ---- */
  const addExam = useMutation({
    mutationFn: async (form: {
      subject: string;
      exam_date: string;
      priority: string;
      notes: string;
      question_pattern: string;
    }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");
      const { error } = await supabase.from("exams").insert({ ...form, user_id: user.id });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["exams"] });
      setAddOpen(false);
      toast.success("Exam added");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ---- Update ---- */
  const updateExam = useMutation({
    mutationFn: async ({
      id,
      ...form
    }: {
      id: string;
      subject: string;
      exam_date: string;
      priority: string;
      notes: string;
      question_pattern: string;
    }) => {
      const { error } = await supabase.from("exams").update(form).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["exams"] });
      setEditExam(null);
      toast.success("Exam updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ---- Delete ---- */
  const delExam = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("exams").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["exams"] });
      toast.success("Deleted");
    },
  });

  /* ---- AI plan ---- */
  const planMut = useMutation({
    mutationFn: async (examId: string) => genPlan({ data: { examId } }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["exams"] });
      toast.success("Study plan generated");
      setPlanOf((p) => p && { ...p, study_plan: res.plan });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mx-auto max-w-5xl p-6 md:p-10">
      {/* Page header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold">Exam timetable</h1>
          <p className="mt-2 text-muted-foreground">
            Add exams, upload study material, and generate AI study plans.
          </p>
        </div>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add exam
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New exam</DialogTitle>
            </DialogHeader>
            <ExamForm
              onSubmit={(form) => addExam.mutate(form)}
              isPending={addExam.isPending}
              submitLabel="Add exam"
            />
          </DialogContent>
        </Dialog>
      </div>

      {/* Exam list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading exams...
        </div>
      ) : !exams.length ? (
        <div className="rounded-2xl border bg-card p-10 text-center text-muted-foreground">
          No exams yet. Add your first one above.
        </div>
      ) : (
        <div className="grid gap-4">
          {exams.map((e) => (
            <ExamCard
              key={e.id}
              exam={e}
              onEdit={setEditExam}
              onDelete={(id) => delExam.mutate(id)}
              onViewPlan={setPlanOf}
            />
          ))}
        </div>
      )}

      {/* ---- Edit Exam Dialog ---- */}
      <Dialog open={!!editExam} onOpenChange={(o) => !o && setEditExam(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit exam</DialogTitle>
          </DialogHeader>
          {editExam && (
            <ExamForm
              defaultValues={editExam}
              onSubmit={(form) => updateExam.mutate({ id: editExam.id, ...form })}
              isPending={updateExam.isPending}
              submitLabel="Save changes"
            />
          )}
        </DialogContent>
      </Dialog>

      {/* ---- Study Plan Dialog ---- */}
      <Dialog open={!!planOf} onOpenChange={(o) => !o && setPlanOf(null)}>
        <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Study plan — {planOf?.subject}</DialogTitle>
          </DialogHeader>
          {planOf?.study_plan ? (
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
              >
                {planOf.study_plan}
              </ReactMarkdown>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No plan generated yet.</div>
          )}
          <Button
            onClick={() => planOf && planMut.mutate(planOf.id)}
            disabled={planMut.isPending}
            className="w-full"
          >
            {planMut.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating...
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />{" "}
                {planOf?.study_plan ? "Regenerate" : "Generate"} AI plan
              </>
            )}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
