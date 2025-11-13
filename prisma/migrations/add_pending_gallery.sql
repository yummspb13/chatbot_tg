-- Добавляем столбец pendingGallery для временного хранения фото до группировки
-- Этот столбец используется для хранения фото из сообщений без текста,
-- которые будут добавлены в gallery когда будет создан draft с текстом

ALTER TABLE public."afisha_bot_DraftEvent"
ADD COLUMN IF NOT EXISTS "pendingGallery" TEXT;

-- Комментарий к столбцу
COMMENT ON COLUMN public."afisha_bot_DraftEvent"."pendingGallery" IS 'JSON массив base64 строк для временного хранения фото из сообщений без текста. Фото будут добавлены в gallery когда будет создан draft с текстом.';

