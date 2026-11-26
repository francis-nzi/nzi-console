import { NziMark } from "@nzi/ui";
import {PortalLoginForm} from "./PortalLoginForm";
const REASON_MESSAGE:Record<string,string>={
  "session-ended":"Your secure session ended. Sign in again to continue.",
  idle:"You were signed out after a period of inactivity. Sign in again to continue.",
  "terms-declined":"You declined the portal terms of access, so you have been signed out. Sign in again to review and accept them.",
};
export default async function PortalLoginPage({searchParams}:{searchParams:Promise<{reason?:string}>}){const {reason}=await searchParams;const message=reason?REASON_MESSAGE[reason]:undefined;return <main className="nz-auth-shell"><section className="nz-auth-story"><div className="nz-auth-brand"><NziMark /><div><b>NZ Insights Pro</b><small>Client portal</small></div></div><div className="nz-auth-promise"><span className="nz-eyebrow light">Your carbon programme</span><h1>Building stronger businesses for a changing climate.</h1><p>Mitigating risk, lowering costs, and protecting growth.</p></div><small className="nz-auth-foot">Authorised client access · Protected by password and MFA</small></section><section className="nz-auth-entry">{message?<div className="nz-banner warn" role="status" style={{marginBottom:14}}>{message}</div>:null}<PortalLoginForm/><a className="nz-auth-secondary" href="/portal/recover" style={{marginTop:18,textAlign:"center"}}>Start account recovery</a></section></main>}
