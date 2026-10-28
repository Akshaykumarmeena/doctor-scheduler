-- btree_gist lets a GiST index mix plain equality (doctor_id WITH =) with range
-- operators (during WITH &&). The slots exclusion constraint needs it.
CREATE EXTENSION IF NOT EXISTS btree_gist;
