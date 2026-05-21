-- Link documents to exams so users can upload notes/past papers per exam
ALTER TABLE public.documents
  ADD COLUMN exam_id UUID REFERENCES public.exams(id) ON DELETE SET NULL;

CREATE INDEX idx_documents_exam ON public.documents(exam_id);
