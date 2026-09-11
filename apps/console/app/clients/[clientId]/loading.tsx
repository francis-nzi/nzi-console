import { ScreenState } from "../../lib/ScreenState";

/** A distinct loading state while the client's figures and sites resolve — never an empty page or zeros. */
export default function ClientLoading() {
  return <ScreenState result={{ state: "loading" }}>{() => null}</ScreenState>;
}
