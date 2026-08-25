BEGIN;
ALTER TABLE nzi_console.report_versions ADD CONSTRAINT report_version_snapshot_fk FOREIGN KEY(organisation_id,reviewed_snapshot_id) REFERENCES nzi_console.reviewed_crp_snapshots(organisation_id,snapshot_id);
CREATE UNIQUE INDEX report_version_validated_snapshot_unique ON nzi_console.report_versions(organisation_id,reviewed_snapshot_id,manifest_version) WHERE status IN ('validated','published');
COMMIT;
