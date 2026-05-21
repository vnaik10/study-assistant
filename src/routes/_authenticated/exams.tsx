import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { Plus, Trash2, Sparkles, Loader2 } from "lucide-react";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { generateStudyPlan } from "@/lib/ai.functions";

export const Route = createFileRoute("/_authenticated/exams")({
  component: ExamsPage,
});

type Exam = {
  id: string;
  subject: string;
  exam_date: string;
  priority: "low" | "medium" | "high";
  notes: string | null;
  study_plan: string | null;
};

function ExamsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
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

  const addExam = useMutation({
    mutationFn: async (form: { subject: string; exam_date: string; priority: string; notes: string }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");
      const { error } = await supabase.from("exams").insert({ ...form, user_id: user.id });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["exams"] }); setOpen(false); toast.success("Exam added"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const delExam = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("exams").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["exams"] }); toast.success("Deleted"); },
  });

  const planMut = useMutation({
    mutationFn: async (examId: string) => genPlan({ data: { examId } }),
    onSuccess: (res) => { qc.invalidateQueries({ queryKey: ["exams"] }); toast.success("Study plan generated"); setPlanOf((p) => p && { ...p, study_plan: res.plan }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mx-auto max-w-5xl p-6 md:p-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold">Exam timetable</h1>
          <p className="mt-2 text-muted-foreground">Add exams and generate AI study plans.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="mr-2 h-4 w-4" />Add exam</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New exam</DialogTitle></DialogHeader>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                addExam.mutate({
                  subject: String(fd.get("subject") || ""),
                  exam_date: String(fd.get("exam_date") || ""),
                  priority: String(fd.get("priority") || "medium"),
                  notes: String(fd.get("notes") || ""),
                });
              }}
            >
              <div><Label htmlFor="subject">Subject</Label><Input id="subject" name="subject" required /></div>
              <div><Label htmlFor="exam_date">Date</Label><Input id="exam_date" name="exam_date" type="date" required /></div>
              <div>
                <Label>Priority</Label>
                <Select name="priority" defaultValue="medium">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div><Label htmlFor="notes">Notes / topics</Label><Textarea id="notes" name="notes" placeholder="Chapters, topics, weak areas..." /></div>
              <Button type="submit" className="w-full" disabled={addExam.isPending}>Add exam</Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="text-muted-foreground">Loading...</div>
      ) : !exams.length ? (
        <div className="rounded-2xl border bg-card p-10 text-center text-muted-foreground">No exams yet. Add your first one above.</div>
      ) : (
        <div className="grid gap-4">
          {exams.map((e) => {
            const days = Math.ceil((new Date(e.exam_date).getTime() - Date.now()) / 86_400_000);
            const priorityColor = e.priority === "high" ? "bg-destructive/15 text-destructive" : e.priority === "medium" ? "bg-gold/20 text-gold-foreground" : "bg-muted text-muted-foreground";
            return (
              <div key={e.id} className="rounded-2xl border bg-card p-5 shadow-elegant">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold">{e.subject}</h3>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${priorityColor}`}>{e.priority}</span>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      {new Date(e.exam_date).toLocaleDateString()} · {days >= 0 ? `${days} days left` : "Past"}
                    </div>
                    {e.notes && <p className="mt-2 text-sm">{e.notes}</p>}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPlanOf(e)}>
                      <Sparkles className="mr-1.5 h-3.5 w-3.5" /> {e.study_plan ? "View plan" : "AI plan"}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => delExam.mutate(e.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={!!planOf} onOpenChange={(o) => !o && setPlanOf(null)}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>Study plan — {planOf?.subject}</DialogTitle></DialogHeader>
          {planOf?.study_plan ? (
            <div className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown>{planOf.study_plan}</ReactMarkdown></div>
          ) : (
            <div className="text-sm text-muted-foreground">No plan generated yet.</div>
          )}
          <Button
            onClick={() => planOf && planMut.mutate(planOf.id)}
            disabled={planMut.isPending}
            className="w-full"
          >
            {planMut.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating...</> : <><Sparkles className="mr-2 h-4 w-4" /> {planOf?.study_plan ? "Regenerate" : "Generate"} AI plan</>}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
