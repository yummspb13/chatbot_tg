-- Дни рождения детей с регистраций на «Модный подиум» (таблица PodiumRegistration).
--
-- Задача: в форме собирали только день и месяц рождения (childBirthDay/childBirthMonth)
-- и возраст на момент регистрации (childAge). Год рождения восстанавливаем из этих двух полей.
--
-- Логика восстановления года:
--   если ДР в год регистрации уже наступил на дату createdAt -> birth_year = год(createdAt) - childAge
--   иначе                                                    -> birth_year = год(createdAt) - childAge - 1
--
-- Дедупликация: один ребёнок мог быть заведён несколько раз (например, отдельной
-- строкой SPECTATOR в дополнение к PARTICIPANT/WAITLIST). Ключ ребёнка —
-- телефон + нормализованное имя + день/месяц ДР. Из дублей берём строку,
-- где есть возраст, SPECTATOR — в последнюю очередь.
--
-- Использование: подставьте нужную дату отсчёта в :today (по умолчанию CURRENT_DATE)
-- и период рассылки в блоке WHERE в самом низу.

WITH params AS (
  SELECT CURRENT_DATE AS today   -- заменить на DATE '2026-08-04' для воспроизведения отчёта
),
src AS (
  SELECT r.*,
         regexp_replace(coalesce(r.phone, ''), '\D', '', 'g')                    AS phone_key,
         lower(regexp_replace(trim(coalesce(r."childName", '')), '\s+', ' ', 'g')) AS name_key
  FROM "PodiumRegistration" r
),
with_year AS (
  SELECT s.*,
         CASE
           WHEN s."childAge" IS NULL OR s."childBirthDay" IS NULL OR s."childBirthMonth" IS NULL THEN NULL
           WHEN make_date(EXTRACT(YEAR FROM s."createdAt")::int, s."childBirthMonth", s."childBirthDay")
                <= s."createdAt"::date
             THEN EXTRACT(YEAR FROM s."createdAt")::int - s."childAge"
           ELSE EXTRACT(YEAR FROM s."createdAt")::int - s."childAge" - 1
         END AS birth_year
  FROM src s
),
keyed AS (
  SELECT w.*,
         w.phone_key || '|' || w.name_key || '|'
           || coalesce(w."childBirthMonth"::text, '?') || '-' || coalesce(w."childBirthDay"::text, '?') AS child_key
  FROM with_year w
),
dedup AS (
  SELECT DISTINCT ON (child_key) *
  FROM keyed
  ORDER BY child_key,
           (type = 'SPECTATOR') ASC,     -- строки-«зрители» считаем дублем
           ("childAge" IS NULL) ASC,     -- приоритет строкам с возрастом
           id ASC
),
next_bday AS (
  SELECT d.*,
         CASE
           WHEN d."childBirthDay" IS NULL OR d."childBirthMonth" IS NULL THEN NULL
           WHEN make_date(EXTRACT(YEAR FROM p.today)::int, d."childBirthMonth", d."childBirthDay") >= p.today
             THEN make_date(EXTRACT(YEAR FROM p.today)::int, d."childBirthMonth", d."childBirthDay")
           ELSE make_date(EXTRACT(YEAR FROM p.today)::int + 1, d."childBirthMonth", d."childBirthDay")
         END AS nb,
         p.today
  FROM dedup d CROSS JOIN params p
)
SELECT
  id                                                        AS registration_id,
  nb                                                        AS birthday_date,
  (nb - today)                                              AS days_until,
  "childName"                                               AS child_name,
  "childGender"                                             AS gender,
  EXTRACT(YEAR FROM nb)::int - birth_year                   AS turns_age,
  birth_year,
  EXTRACT(YEAR FROM nb)::int - birth_year - 1               AS age_now,
  type,
  status,
  "parentName"                                              AS parent_name,
  phone,
  email,
  telegram,
  "consentMarketing"                                        AS consent_marketing
FROM next_bday
WHERE nb IS NOT NULL
  AND status <> 'CANCELLED'                     -- убрать условие, если нужны отменённые
  -- AND nb < date_trunc('month', today) + INTERVAL '1 month'   -- только текущий месяц
ORDER BY nb, child_name;
