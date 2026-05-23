-- Migration: Create note_images bucket
INSERT INTO storage.buckets (id, name, public) 
VALUES ('note_images', 'note_images', true)
ON CONFLICT (id) DO NOTHING;

-- RLS Policies for note_images bucket

CREATE POLICY "Users can upload images"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'note_images' AND 
  auth.uid() = owner
);

CREATE POLICY "Anyone can view images"
ON storage.objects FOR SELECT
USING (bucket_id = 'note_images');

CREATE POLICY "Users can delete own images"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'note_images' AND auth.uid() = owner);

CREATE POLICY "Users can update own images"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'note_images' AND auth.uid() = owner);
