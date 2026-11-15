-- Append-only audit links now accept existing sorting and assembly run
-- snapshots. Metrics describe manually attested local fields, not verified
-- production yield, stock movement, quality release, or equipment status.
BEGIN;
ALTER TABLE production_local_journal_links
  DROP CONSTRAINT production_local_source_kind_allowed,
  DROP CONSTRAINT production_local_source_measure_kind_allowed,
  DROP CONSTRAINT production_local_source_stage_kind,
  DROP CONSTRAINT production_local_source_measure_pair;
ALTER TABLE production_local_journal_links
  ADD CONSTRAINT production_local_source_kind_allowed CHECK (
    source_kind IN ('journal','mix_batch','coat_run','calender_run','cut_run',
                    'sort_run','assembly_run')
  ),
  ADD CONSTRAINT production_local_source_measure_kind_allowed CHECK (
    source_measure_kind IS NULL OR source_measure_kind IN
      ('dry_solids_kg','coated_side_a_m','calendered_length_m','cut_good_pieces',
       'sort_input_good_pieces','assembled_cells_out')
  ),
  ADD CONSTRAINT production_local_source_stage_kind CHECK (
    source_kind='journal'
    OR (source_kind='mix_batch' AND source_stage='slurry')
    OR (source_kind='coat_run' AND source_stage='coating')
    OR (source_kind='calender_run' AND source_stage='calendaring')
    OR (source_kind='cut_run' AND source_stage='cutting')
    OR (source_kind='sort_run' AND source_stage='sorting')
    OR (source_kind='assembly_run' AND source_stage='assembly')
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
      OR (source_kind='sort_run' AND source_stage='sorting'
        AND source_measure_kind='sort_input_good_pieces'
        AND source_measure_value=trunc(source_measure_value))
      OR (source_kind='assembly_run' AND source_stage='assembly'
        AND source_measure_kind='assembled_cells_out'
        AND source_measure_value=trunc(source_measure_value))
    ))
  );
COMMIT;
