-- Team Notes (team-note tracker type) keep a revision history like the
-- knowledge kinds: a note's edits are its audit trail. Idempotent.
INSERT INTO tracker_revision_types (type) VALUES ('team-note')
ON CONFLICT (type) DO NOTHING;
