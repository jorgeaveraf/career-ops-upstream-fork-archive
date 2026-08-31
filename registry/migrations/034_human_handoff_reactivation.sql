CREATE TRIGGER IF NOT EXISTS human_handoffs_reactivation_reset
AFTER UPDATE OF status ON human_handoffs
WHEN NEW.status = 'ACTIVE'
BEGIN
  UPDATE human_handoffs
  SET handoff_resolved_at = NULL,
      resume_started_at = NULL,
      resume_completed_at = NULL,
      resume_result_json = '{}'
  WHERE id = NEW.id;
END;
