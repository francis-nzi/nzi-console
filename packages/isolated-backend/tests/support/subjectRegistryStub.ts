/**
 * An in-memory subject registry, for the suites that test a command against a fake pool (NZC-119).
 *
 * Writing personal data now also resolves a subject, mints its key and records a linkage digest. The
 * contract suites answer SQL by matching on it and return no rows for anything they do not recognise,
 * which for the key read-back means "nothing stored" — so without this they fail on the registry
 * rather than on the contract they are about.
 *
 * Faithful enough to be worth having: it remembers a link once made, so a second write to the same row
 * reuses the same subject rather than minting a rival one, which is the property the real table's
 * primary key enforces. One implementation, composed by each stub, so the behaviour cannot drift
 * between suites.
 */

type Rows = { rows: Record<string, unknown>[] };
type Query = (sql: string, values?: readonly unknown[]) => Promise<Rows>;

export function answeringSubjectRegistry(inner: Query): Query {
  const links = new Map<string, string>();
  const keys = new Map<string, unknown>();
  const at = (values: readonly unknown[] | undefined, index: number) => String(values?.[index] ?? "");

  return async (sql, values) => {
    if (sql.includes("FROM nzi_console.data_subject_links")) {
      const subjectId = links.get(`${at(values, 0)}|${at(values, 1)}|${at(values, 2)}`);
      return { rows: subjectId ? [{ subject_id: subjectId }] : [] };
    }
    if (sql.includes("INSERT INTO nzi_console.data_subject_links")) {
      links.set(`${at(values, 0)}|${at(values, 2)}|${at(values, 3)}`, at(values, 1));
      return { rows: [] };
    }
    if (sql.includes("FROM nzi_console.data_subject_keys")) {
      const wrapped = keys.get(`${at(values, 0)}|${at(values, 1)}`);
      return { rows: wrapped ? [{ wrapped_key: wrapped }] : [] };
    }
    if (sql.includes("INSERT INTO nzi_console.data_subject_keys")) {
      const id = `${at(values, 0)}|${at(values, 1)}`;
      if (keys.has(id)) return { rows: [] };
      const wrapped = JSON.parse(at(values, 2));
      keys.set(id, wrapped);
      return { rows: [{ wrapped_key: wrapped }] };
    }
    // The linkage table is reached only through its definer functions (NZC-121), so these are what a
    // fake pool has to answer. No subject is offered back: a stub that claimed a match would make the
    // suites depend on linkage behaviour they are not about.
    if (sql.includes("nzi_console.subjects_sharing_linkage")
      || sql.includes("nzi_console.record_subject_linkage")
      || sql.includes("INSERT INTO nzi_console.data_subjects")) {
      return { rows: [] };
    }
    return inner(sql, values);
  };
}
