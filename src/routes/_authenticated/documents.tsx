import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { FileText, Plus, Trash2, MessageSquare, Loader2, Upload } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { extractPdfText } from "@/lib/pdf";

export const Route = createFileRoute("/_authenticated/documents")({
  component: DocumentsPage,
});

type Doc = {
  id: string;
  title: string;
  subject: string | null;
  doc_type: string;
  content: string;
  created_at: string;
};

function DocumentsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  const { data: docs = [], isLoading } = useQuery({
    queryKey: ["documents"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("documents")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Doc[];
    },
  });

  const addDoc = useMutation({
    mutationFn: async (form: { title: string; subject: string; doc_type: string; content: string }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");
      const { error } = await supabase.from("documents").insert({ ...form, user_id: user.id });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["documents"] }); setOpen(false); toast.success("Document added"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const delDoc = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("documents").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["documents"] }); toast.success("Deleted"); },
  });

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const file = fd.get("file") as File | null;
    let content = String(fd.get("content") || "");
    let title = String(fd.get("title") || "");
    let docType = String(fd.get("doc_type") || "notes");

    if (file && file.size > 0) {
      setUploading(true);
      try {
        if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
          content = await extractPdfText(file);
          docType = docType === "notes" ? "pdf" : docType;
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
    addDoc.mutate({ title: title || "Untitled", subject: String(fd.get("subject") || ""), doc_type: docType, content });
  };

  return (
    <div className="mx-auto max-w-6xl p-6 md:p-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold">Library</h1>
          <p className="mt-2 text-muted-foreground">Upload PDFs, notes, and past papers — chat with them or generate summaries.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="mr-2 h-4 w-4" />Add document</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>Add document</DialogTitle></DialogHeader>
            <form className="space-y-4" onSubmit={onSubmit}>
              <div><Label htmlFor="title">Title</Label><Input id="title" name="title" placeholder="(optional, autofills from file)" /></div>
              <div><Label htmlFor="subject">Subject</Label><Input id="subject" name="subject" /></div>
              <div>
                <Label>Type</Label>
                <Select name="doc_type" defaultValue="notes">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="notes">Notes</SelectItem>
                    <SelectItem value="pdf">PDF</SelectItem>
                    <SelectItem value="past_paper">Past paper</SelectItem>
                    <SelectItem value="assignment">Assignment</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="file">Upload PDF or text file</Label>
                <Input id="file" name="file" type="file" accept=".pdf,.txt,.md" />
              </div>
              <div>
                <Label htmlFor="content">Or paste content</Label>
                <Textarea id="content" name="content" rows={5} placeholder="Paste notes or content..." />
              </div>
              <Button type="submit" className="w-full" disabled={addDoc.isPending || uploading}>
                {uploading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Extracting...</> : <><Upload className="mr-2 h-4 w-4" /> Save</>}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="text-muted-foreground">Loading...</div>
      ) : !docs.length ? (
        <div className="rounded-2xl border bg-card p-10 text-center text-muted-foreground">
          No documents yet. Upload your first notes or PDF.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {docs.map((d) => (
            <div key={d.id} className="flex flex-col rounded-2xl border bg-card p-5 shadow-elegant">
              <div className="mb-3 flex items-center gap-2">
                <FileText className="h-4 w-4 text-primary" />
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{d.doc_type}</span>
              </div>
              <h3 className="font-semibold leading-snug">{d.title}</h3>
              {d.subject && <div className="mt-1 text-xs text-muted-foreground">{d.subject}</div>}
              <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">{d.content.slice(0, 200)}</p>
              <div className="mt-4 flex items-center justify-between border-t pt-3">
                <Link to="/documents/$id" params={{ id: d.id }}>
                  <Button size="sm" variant="outline">
                    <MessageSquare className="mr-1.5 h-3.5 w-3.5" /> Open
                  </Button>
                </Link>
                <Button size="icon" variant="ghost" onClick={() => delDoc.mutate(d.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
