-- Live face check: the employee's face descriptor (128 numbers computed in the admin's browser from the enrolment
-- photo). Employees can read their own row, so their phone can compare the live camera against it.
alter table public.profiles add column if not exists face_descriptor jsonb;
