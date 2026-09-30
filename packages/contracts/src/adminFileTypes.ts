import { defineListSpec, type ListQuery } from "./listQuery";

/**
 * Job file types (admin Phase C3; ruled plan `admin-phaseC-plan.md` Q9): the job file-type vocabulary and its storage
 * folder. Built now and inert — the console has no job-file store yet, so nothing references a type ("in use: none
 * yet"). A type's key never changes once made (0139 grants no UPDATE on it), and v7's two system types are always
 * active: they cannot be deactivated.
 */
export const FILE_TYPE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;
export const FILE_TYPE_FOLDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const FILE_TYPE_NAME_MAX = 120;

/** The File types list: search (name, key), the All / Active / Inactive segment; in the types' own order. */
export const fileTypeListSpec = defineListSpec({
  sortKeys: ["sortOrder", "name", "key", "status"] as const,
  defaultSort: { key: "sortOrder", dir: "asc" },
  filters: { status: "value" },
});
export type FileTypeListSortKey = (typeof fileTypeListSpec.sortKeys)[number];
export type FileTypeListFilterKey = keyof typeof fileTypeListSpec.filters;
export type FileTypeListQuery = ListQuery<FileTypeListSortKey, FileTypeListFilterKey>;

/** What an edit may change — never the key. */
export type FileTypeEditableFields = { displayName: string; storageFolderKey: string; sortOrder?: number };
