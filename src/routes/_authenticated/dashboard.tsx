import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Calendar, FileText, Flame, BookOpen } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border bg-card p-5 shadow-elegant">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div className="mt-3 font-display text-3xl font-semibold">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Dashboard() {
  const { user } = useAuth();

  const { data: exams } = useQuery({
    queryKey: ["exams-upcoming"],
    queryFn: async () => {
      const { data } = await supabase
        .from("exams")
        .select("*")
        .gte("exam_date", new Date().toISOString().slice(0, 10))
        .order("exam_date", { ascending: true })
        .limit(5);
      return data ?? [];
    },
  });

  const { data: docCount } = useQuery({
    queryKey: ["doc-count"],
    queryFn: async () => {
      const { count } = await supabase
        .from("documents")
        .select("*", { count: "exact", head: true });
      return count ?? 0;
    },
  });

  const { data: sessions } = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const { data } = await supabase
        .from("study_sessions")
        .select("session_date, minutes")
        .order("session_date", { ascending: false })
        .limit(30);
      return data ?? [];
    },
  });

  // streak calc
  const streak = (() => {
    if (!sessions?.length) return 0;
    const dates = new Set(sessions.map((s) => s.session_date));
    let n = 0;
    const cur = new Date();
    while (dates.has(cur.toISOString().slice(0, 10))) {
      n++;
      cur.setDate(cur.getDate() - 1);
    }
    return n;
  })();

  const totalMinutes = sessions?.reduce((a, s) => a + s.minutes, 0) ?? 0;
  const name = user?.email?.split("@")[0] ?? "student";

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6 md:p-10">
      <div>
        <h1 className="font-display text-3xl font-semibold">Welcome back, {name} 👋</h1>
        <p className="mt-2 text-muted-foreground">Here's your study overview.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Calendar} label="Upcoming exams" value={exams?.length ?? 0} />
        <StatCard icon={FileText} label="Library docs" value={docCount ?? 0} />
        <StatCard icon={Flame} label="Day streak" value={streak} hint="Daily study streak" />
        <StatCard
          icon={BookOpen}
          label="Study time (30d)"
          value={`${Math.round(totalMinutes / 60)}h`}
        />
      </div>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-xl font-semibold">Next exams</h2>
          <Link to="/exams" className="text-sm text-primary hover:underline">
            Manage all →
          </Link>
        </div>
        {!exams?.length ? (
          <div className="rounded-2xl border bg-card p-8 text-center text-muted-foreground">
            No upcoming exams.{" "}
            <Link to="/exams" className="text-primary hover:underline">
              Add one
            </Link>
            .
          </div>
        ) : (
          <div className="grid gap-3">
            {exams.map((e) => {
              const days = Math.max(
                0,
                Math.ceil((new Date(e.exam_date).getTime() - Date.now()) / 86_400_000),
              );
              return (
                <div
                  key={e.id}
                  className="flex items-center justify-between rounded-xl border bg-card p-4"
                >
                  <div>
                    <div className="font-medium">{e.subject}</div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(e.exam_date).toLocaleDateString()} · {e.priority}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-display text-2xl font-semibold text-primary">{days}</div>
                    <div className="text-xs text-muted-foreground">days left</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <Link
          to="/documents"
          className="rounded-2xl border bg-card p-6 transition hover:shadow-elegant"
        >
          <FileText className="h-5 w-5 text-primary" />
          <div className="mt-3 font-semibold">Upload notes & chat with them</div>
          <p className="mt-1 text-sm text-muted-foreground">
            Drop a PDF, get an AI tutor that knows your material.
          </p>
        </Link>
        <Link to="/chat" className="rounded-2xl border bg-card p-6 transition hover:shadow-elegant">
          <BookOpen className="h-5 w-5 text-primary" />
          <div className="mt-3 font-semibold">Ask the AI tutor anything</div>
          <p className="mt-1 text-sm text-muted-foreground">
            General Q&A, explanations, concept breakdowns.
          </p>
        </Link>
      </section>
    </div>
  );
}
