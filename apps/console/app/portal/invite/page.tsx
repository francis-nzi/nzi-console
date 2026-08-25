import {PortalInviteSetup} from "./PortalInviteSetup";
export default async function PortalInvitePage({searchParams}:{searchParams:Promise<{token?:string}>}){const {token=""}=await searchParams;return <main style={{minHeight:"100vh",display:"grid",placeItems:"center",background:"#F1F5F3",padding:16}}><PortalInviteSetup token={token}/></main>}
