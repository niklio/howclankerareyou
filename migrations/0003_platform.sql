-- Reddit support: which platform an account diagnosis came from.
-- NULL = 'x' (all pre-existing rows are X diagnoses).
ALTER TABLE results ADD COLUMN subject_platform TEXT;
