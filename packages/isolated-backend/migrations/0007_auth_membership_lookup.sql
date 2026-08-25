BEGIN;

-- Authentication must confirm that a credential still belongs to an active
-- staff membership. The dedicated auth role may see only membership rows that
-- have a corresponding Console credential; it receives no membership writes.
CREATE POLICY auth_credential_membership_lookup
  ON nzi_console.memberships
  FOR SELECT
  TO nzi_console_auth
  USING (EXISTS (
    SELECT 1
    FROM nzi_console.staff_credentials credential
    WHERE credential.organisation_id = memberships.organisation_id
      AND credential.user_id = memberships.user_id
      AND credential.enabled = true
  ));

COMMIT;
