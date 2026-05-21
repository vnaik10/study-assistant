import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { BookOpen, Calendar, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/_authenticated/notes/")({
  component: NotesIndex,
});

function NotesIndex() {
  const { user } = useAuth();

  const { data: exams, isLoading } = useQuery({
    queryKey: ["exams", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data } = await supabase
        .from("exams")
        .select("*")
        .eq("user_id", user.id)
        .order("exam_date", { ascending: true });
      return data ?? [];
    },
    enabled: !!user,
  });

  return (
    <div className="flex-1 space-y-6 p-8">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight">Your Notebooks</h1>
        <p className="text-muted-foreground mt-2">
          Select an exam to organize its notes into chapters and folders.
        </p>
      </div>

      {isLoading ? (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 rounded-xl border bg-card/50 animate-pulse" />
          ))}
        </div>
      ) : exams?.length === 0 ? (
        <div className="flex h-[400px] flex-col items-center justify-center rounded-2xl border border-dashed bg-card/50 text-center">
          <BookOpen className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="font-display text-xl font-semibold">No notebooks yet</h3>
          <p className="mt-2 text-sm text-muted-foreground max-w-sm">
            You need to create an exam first. Notebooks are automatically generated for each of your exams.
          </p>
          <Link
            to="/exams"
            className="mt-6 inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
          >
            Create your first Exam
          </Link>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {exams?.map((exam) => (
            <Link
              key={exam.id}
              to={`/notes/${exam.id}`}
              className="group flex flex-col justify-between rounded-xl border bg-card p-6 shadow-sm transition-all hover:border-primary/50 hover:shadow-md"
            >
              <div>
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                  <BookOpen className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-display text-xl font-semibold group-hover:text-primary transition-colors">
                  {exam.subject}
                </h3>
                <div className="mt-2 flex items-center text-sm text-muted-foreground">
                  <Calendar className="mr-1.5 h-4 w-4" />
                  {new Date(exam.exam_date).toLocaleDateString()}
                </div>
              </div>
              
              <div className="mt-6 flex items-center text-sm font-medium text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                Open Notebook <ArrowRight className="ml-1.5 h-4 w-4" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
