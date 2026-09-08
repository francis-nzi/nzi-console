// P2b — the portal terms-of-access copy shown by PortalTermsGate. The version
// gate is `NZI_PORTAL_TERMS_VERSION` (server, default "2026-v1"); bumping it
// re-prompts every existing user. Update this copy and the version together.
export const PORTAL_TERMS_HEADING = "NZI Pro Client Portal — Terms of Access";

export const PORTAL_TERMS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "1. Acceptance",
    body: "By accessing or using the client portal you agree to be bound by these terms. If you do not agree you must not access the portal.",
  },
  {
    title: "2. Access and authorisation",
    body: "Access is granted by Net Zero International to named individuals of the relevant client organisation. Your credentials are personal to you and must not be shared. You are responsible for all activity under your account.",
  },
  {
    title: "3. Confidentiality",
    body: "All data, reports and materials in the portal are confidential and proprietary to NZI and/or the relevant client. You must not copy, distribute or disclose them to any third party without NZI's prior written consent.",
  },
  {
    title: "4. Acceptable use",
    body: "You must not attempt to gain unauthorised access to any part of the portal or related systems, or interfere with its integrity or performance.",
  },
  {
    title: "5. Reported figures",
    body: "Figures shown in the portal are drawn from assured, published report versions. Draft or in-progress values are never shown as reported results.",
  },
  {
    title: "6. Limitation of liability",
    body: "To the maximum extent permitted by law, NZI is not liable for any indirect, incidental, special or consequential loss arising from your use of the portal.",
  },
  {
    title: "7. Governing law",
    body: "These terms are governed by the laws of England and Wales, whose courts have exclusive jurisdiction over any dispute.",
  },
  {
    title: "8. Changes",
    body: "NZI may update these terms. You will be asked to re-accept a material update before continuing to access the portal.",
  },
];
