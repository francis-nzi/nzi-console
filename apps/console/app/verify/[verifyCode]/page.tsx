import { verifyTrainingCertificate, type CertificateVerification } from "@nzi/isolated-backend";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { formatDate } from "../../lib/formatDate";

export const dynamic = "force-dynamic";

/**
 * Public certificate verification — no account, no session, no tenant.
 *
 * This page exists so a certificate is worth something outside NZI: a future employer with
 * the code in front of them can confirm it. That makes it the one page in the platform a
 * stranger can reach, so it is deliberately narrow — it renders only what
 * `verify_training_certificate` returns, and that function cannot return contact details,
 * an employer, or anything else the person has trained on.
 *
 * A code that does not match says so plainly and identically whatever the reason, so the
 * page cannot be used to enumerate certificates or confirm a guessed name.
 */
export default async function VerifyCertificatePage({ params }: { params: Promise<{ verifyCode: string }> }) {
  const { verifyCode } = await params;
  let result: CertificateVerification;
  try {
    result = await verifyTrainingCertificate(isolatedPool(), decodeURIComponent(verifyCode));
  } catch {
    // Truth before availability: a lookup that failed is not a certificate that is invalid.
    return <VerifyShell>
      <div className="nz-verify-card unavailable" role="alert">
        <h1>Verification is temporarily unavailable</h1>
        <p>This certificate could not be checked just now. That is not a statement about the certificate — please try again shortly.</p>
      </div>
    </VerifyShell>;
  }

  if (result.state === "not-found") {
    return <VerifyShell>
      <div className="nz-verify-card unknown">
        <h1>No certificate found</h1>
        <p>
          No certificate matches this code. Check the code on the certificate — it is printed beneath the
          QR code and begins <code>NZI-</code>.
        </p>
      </div>
    </VerifyShell>;
  }

  const revoked = result.state === "revoked";
  return <VerifyShell>
    <div className={`nz-verify-card ${revoked ? "revoked" : "valid"}`}>
      <span className="nz-verify-badge">{revoked ? "Withdrawn" : "Verified"}</span>
      <h1>{result.personName}</h1>
      <p className="nz-verify-course">{result.courseName}</p>
      <dl className="nz-verify-facts">
        <div><dt>Completed</dt><dd>{result.completedOn === null ? "—" : formatDate(result.completedOn)}</dd></div>
        <div><dt>Attendance</dt><dd className="num">{result.attendancePct}%</dd></div>
        <div><dt>Certificate</dt><dd>{result.certificateNumber}</dd></div>
        <div><dt>Issued</dt><dd>{formatDate(result.issuedOn)}</dd></div>
        <div><dt>Issued by</dt><dd>{result.issuer}</dd></div>
      </dl>
      {revoked
        ? <p className="nz-verify-note">
          This certificate was withdrawn{result.revokedOn ? ` on ${formatDate(result.revokedOn)}` : ""}. It is
          shown here rather than hidden, so that a copy still in circulation can be recognised for what it is.
        </p>
        : <p className="nz-verify-note">
          This record is held by Net Zero International and confirms the training above. It shows only the
          training itself — no contact details, no employer, and nothing else this person has studied.
        </p>}
    </div>
  </VerifyShell>;
}

function VerifyShell({ children }: { children: React.ReactNode }) {
  return <main className="nz-verify-shell">
    <div className="nz-verify-brand"><span>N</span><div><b>NZI Pro</b><small>Certificate verification</small></div></div>
    {children}
  </main>;
}
