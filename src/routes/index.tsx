import { createFileRoute, Link } from "@tanstack/react-router";
import { Sparkles, BookOpen, Calendar, MessageSquare, Brain, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Feature({
  icon: Icon,
  title,
  desc,
}: {
  icon: React.ElementType;
  title: string;
  desc: string;
}) {
  return (
    <div className="rounded-2xl border bg-card p-6 shadow-elegant">
      <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg gradient-gold">
        <Icon className="h-5 w-5 text-gold-foreground" />
      </div>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{desc}</p>
    </div>
  );
}

function Landing() {
  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md gradient-hero">
              <Sparkles className="h-4 w-4 text-gold" />
            </div>
            <span className="font-display text-xl font-semibold">Scholaria</span>
          </Link>
          <div className="flex items-center gap-3">
            <Link to="/login">
              <Button variant="ghost">Sign in</Button>
            </Link>
            <Link to="/login">
              <Button>Get started</Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="gradient-hero">
        <div className="mx-auto max-w-6xl px-6 py-24 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-gold/30 bg-sidebar-accent/40 px-4 py-1 text-xs font-medium text-gold">
            <Sparkles className="h-3 w-3" /> AI-powered exam preparation
          </span>
          <h1 className="mt-6 font-display text-5xl font-semibold tracking-tight text-sidebar-foreground sm:text-6xl">
            Study smarter,
            <br /> not harder.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-sidebar-foreground/80">
            Upload your notes and past papers, chat with an AI tutor that knows your material, and
            follow a personalized day-by-day plan for every exam.
          </p>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <Link to="/login">
              <Button size="lg" className="bg-gold text-gold-foreground hover:opacity-90">
                Start studying free
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-6xl px-6 py-24">
        <h2 className="font-display text-3xl font-semibold">Everything you need to ace exams</h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          One elegant workspace combining a chat-with-PDF tutor, exam planner, and AI revision
          tools.
        </p>
        <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          <Feature
            icon={FileText}
            title="Chat with your PDFs"
            desc="Upload notes & past papers, then ask anything — the AI answers from your material."
          />
          <Feature
            icon={Calendar}
            title="Smart exam planner"
            desc="Add exams and get a personalized day-by-day study roadmap."
          />
          <Feature
            icon={Brain}
            title="Auto summaries & quizzes"
            desc="One click for revision notes, flashcards, mind maps, MCQs, and viva questions."
          />
          <Feature
            icon={MessageSquare}
            title="Context-aware tutor"
            desc="Memory-based conversations scoped to each document."
          />
          <Feature
            icon={BookOpen}
            title="Important topics"
            desc="Detect likely exam questions and weightage from past papers."
          />
          <Feature
            icon={Sparkles}
            title="Streaks & analytics"
            desc="Track daily study time, topics covered, and progress per exam."
          />
        </div>
      </section>

      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} Scholaria
      </footer>
    </div>
  );
}
