-- Add question paper pattern field to exams
ALTER TABLE public.exams ADD COLUMN question_pattern TEXT;
