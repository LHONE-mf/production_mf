-- M2 manual reference expansion for existing calendering and cutting runs.
-- All records remain chief-attested snapshots, never yield, QC, inventory,
-- machinery instructions or route-step completion evidence.
BEGIN;
ALTER TABLE production_local_journal_links
  DROP CONSTRAINT production_local_journal_links_source_kind_check,
  DROP CONSTRAINT production_local_journal_links_source_measure_kind_check,
  DROP CONSTRAINT production_local_source_stage_kind,
  DROP CONSTRAINT production_local_source_measure_pair;

ALTER TABLE production_local_journal_links
  ADD CONSTRAINT production_local_source_kind_allowed CHECK (
    source_kind IN ('journal','mix_batch','coat_run','calender_run','cut_run')
  ),
  ADD CONSTRAINT production_local_source_measure_kind_allowed CHECK (
    source_measure_kind IS NULL OR source_measure_kind IN
      ('dry_solids_kg','coated_side_a_m','calendered_length_m','cut_good_pieces')
  ),
  ADD CONSTRAINT production_local_source_stage_kind CHECK (
    source_kind='journal'
    OR (source_kind='mix_batch' AND source_stage='slurry')
    OR (source_kind='coat_run' AND source_stage='coating')
    OR (source_kind='calender_run' AND source_stage='calendaring')
    OR (source_kind='cut_run' AND source_stage='cutting')
  ),
  ADD CONSTRAINT production_local_source_measure_pair CHECK (
    (source_measure_kind IS NULL AND source_measure_value IS NULL)
    OR (source_measure_kind IS NOT NULL AND source_measure_value IS NOT NULL AND (
      (source_kind='mix_batch' AND source_stage='slurry'
        AND source_measure_kind='dry_solids_kg')
      OR (source_kind='coat_run' AND source_stage='coating'
        AND source_measure_kind='coated_side_a_m')
      OR (source_kind='calender_run' AND source_stage='calendaring'
        AND source_measure_kind='calendered_length_m')
      OR (source_kind='cut_run' AND source_stage='cutting'
        AND source_measure_kind='cut_good_pieces'
        AND source_measure_value=trunc(source_measure_value))
    ))
  );
COMMIT;
