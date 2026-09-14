import assert from "node:assert/strict";
import { describe, it } from "node:test";
// @ts-expect-error — the runner is plain ESM, deliberately dependency-light and runnable
// without a build step. Its decision logic is pure and is what this file exercises.
import { assertDisposable, migrationFiles, needsBaseline, reconcile, refuseOn } from "../scripts/migrate.mjs";

/**
 * The runner's refusals.
 *
 * These are the safety-critical part: everything else is bookkeeping, but a runner that
 * quietly fills an out-of-order gap, or runs a file that changed after it was applied, does
 * more damage than hand-applying ever did — because it does it while looking authoritative.
 *
 * Pure logic, so it is tested without a database. Whether the SQL actually runs is
 * `migrationsRun.test.ts`, against a real Postgres.
 */

type File = { filename: string; checksum: string };
const file = (filename: string, checksum = `sha256:${filename}`): File => ({ filename, checksum });
const ledger = (entries: Array<[string, string]>) =>
  new Map(entries.map(([filename, checksum]) => [filename, { filename, checksum, baselined: false }]));

describe("the migrate runner's decisions", () => {
  describe("pending", () => {
    it("is everything the ledger has not recorded, in file order", () => {
      const files = [file("0001_a.sql"), file("0002_b.sql"), file("0003_c.sql")];
      const { pending } = reconcile(files, ledger([["0001_a.sql", "sha256:0001_a.sql"]]));
      assert.deepEqual(pending.map((entry: File) => entry.filename), ["0002_b.sql", "0003_c.sql"]);
    });

    it("is empty when everything is recorded", () => {
      const files = [file("0001_a.sql")];
      const { pending } = reconcile(files, ledger([["0001_a.sql", "sha256:0001_a.sql"]]));
      assert.equal(pending.length, 0);
    });
  });

  describe("gaps", () => {
    it("refuses an unapplied migration that sorts before an applied one", () => {
      // The staging failure in miniature: something later got applied by hand while an
      // earlier migration never did. Running the earlier one now would execute it against a
      // schema it was never written for.
      const files = [file("0001_a.sql"), file("0002_b.sql"), file("0003_c.sql")];
      const state = reconcile(files, ledger([["0001_a.sql", "sha256:0001_a.sql"], ["0003_c.sql", "sha256:0003_c.sql"]]));
      assert.deepEqual(state.gaps, ["0002_b.sql"]);
      assert.throws(() => refuseOn(state), /Out-of-order migrations[\s\S]*0002_b\.sql/);
    });

    it("does not call a normal tail of pending migrations a gap", () => {
      const files = [file("0001_a.sql"), file("0002_b.sql"), file("0003_c.sql")];
      const state = reconcile(files, ledger([["0001_a.sql", "sha256:0001_a.sql"]]));
      assert.deepEqual(state.gaps, []);
      assert.doesNotThrow(() => refuseOn(state));
    });

    it("does not treat unused migration numbers as gaps", () => {
      // The real numbering skips 61 and 65. A runner that checked numeric contiguity would
      // refuse every run forever.
      const files = [file("0060_a.sql"), file("0062_b.sql"), file("0066_c.sql")];
      const state = reconcile(files, ledger([
        ["0060_a.sql", "sha256:0060_a.sql"], ["0062_b.sql", "sha256:0062_b.sql"], ["0066_c.sql", "sha256:0066_c.sql"],
      ]));
      assert.deepEqual(state.gaps, []);
      assert.doesNotThrow(() => refuseOn(state));
    });
  });

  describe("checksums", () => {
    it("refuses a migration edited after it was applied", () => {
      // The 0072 case. The database may hold either version and there is no way to tell
      // from here, so the runner stops rather than guessing.
      const files = [file("0001_a.sql", "sha256:edited")];
      const state = reconcile(files, ledger([["0001_a.sql", "sha256:original"]]));
      assert.equal(state.drifted.length, 1);
      assert.throws(() => refuseOn(state), /changed after they were applied[\s\S]*0001_a\.sql/);
      // The message must carry both hashes — "it changed" without saying to what is not
      // actionable at 3am.
      assert.throws(() => refuseOn(state), /sha256:original[\s\S]*sha256:edited/);
    });

    it("says a migration is frozen once applied", () => {
      const state = reconcile([file("0001_a.sql", "sha256:new")], ledger([["0001_a.sql", "sha256:old"]]));
      assert.throws(() => refuseOn(state), /frozen once applied/);
    });

    it("passes when every recorded checksum still matches", () => {
      const files = [file("0001_a.sql"), file("0002_b.sql")];
      const state = reconcile(files, ledger([["0001_a.sql", "sha256:0001_a.sql"]]));
      assert.equal(state.drifted.length, 0);
      assert.doesNotThrow(() => refuseOn(state));
    });
  });

  describe("orphans", () => {
    it("refuses when a recorded migration has no file behind it", () => {
      // Deleted or renamed after being applied: the same unanswerable question as drift.
      const state = reconcile([file("0001_a.sql")], ledger([
        ["0001_a.sql", "sha256:0001_a.sql"], ["0002_gone.sql", "sha256:0002_gone.sql"],
      ]));
      assert.deepEqual(state.orphans, ["0002_gone.sql"]);
      assert.throws(() => refuseOn(state), /no file on disk[\s\S]*0002_gone\.sql/i);
    });
  });

  describe("reading the real migrations", () => {
    it("orders by filename, and puts the ledger first", () => {
      const files = migrationFiles();
      assert.ok(files.length > 70, "all the migrations are found");
      assert.match(files[0].filename, /^0000_schema_migrations\.sql$/, "the ledger sorts first, so it is simply the first pending migration");
      const names = files.map((entry: File) => entry.filename);
      assert.deepEqual(names, [...names].sort(), "apply order is sort order");
    });

    it("knows which files manage their own transaction", () => {
      // Most do; 0059 and 0060 do not. The runner wraps the ones that do not, which is what
      // lets their ledger row be written in the same transaction.
      const files = migrationFiles();
      const ledgerFile = files.find((entry: { filename: string }) => entry.filename.startsWith("0000_"));
      assert.equal(ledgerFile.selfTransacting, false, "the ledger migration must be wrappable, so its first row is atomic");
      const selfTransacting = files.filter((entry: { selfTransacting: boolean }) => entry.selfTransacting).length;
      assert.ok(selfTransacting > 60, "the existing migrations carry their own BEGIN/COMMIT");
    });

    it("gives every migration a distinct checksum", () => {
      const files = migrationFiles();
      const checksums = new Set(files.map((entry: File) => entry.checksum));
      assert.equal(checksums.size, files.length, "no two migrations hash the same");
      for (const entry of files) assert.match(entry.checksum, /^sha256:[0-9a-f]{64}$/);
    });
  });
});

describe("the throwaway-database guard", () => {
  // Exercised here because migrationsRun.test.ts skips without a database, and the guard is
  // precisely the thing that must work when someone points it at the wrong one. It imports
  // the real implementation — a copy defined in the test would only prove the copy right.

  it("accepts a database named as disposable", () => {
    for (const name of ["nzi_migrations_ci", "ci", "test", "nzi-test", "throwaway_db", "tmp_run"]) {
      assert.doesNotThrow(() => assertDisposable(`postgres://u:p@localhost:5432/${name}`), name);
    }
  });

  it("refuses anything that does not say it is disposable", () => {
    // The one that matters: a staging URL pasted into the wrong variable.
    for (const name of ["nzi_console", "postgres", "staging", "nzi_staging", "latest"]) {
      assert.throws(() => assertDisposable(`postgres://u:p@localhost:5432/${name}`), /not named as a disposable database/, name);
    }
  });

  it("refuses even a well-named database if it is the isolated one", () => {
    const url = "postgres://u:p@host:5432/nzi_test";
    assert.throws(() => assertDisposable(url, url), /same database as NZI_ISOLATED_DATABASE_URL/);
  });

  it("does not match a name that merely contains the letters", () => {
    // 'latest' ends in 'test'; 'precise' contains 'ci'. A substring check would have let
    // both through.
    assert.throws(() => assertDisposable("postgres://u:p@h:5432/latest"), /not named as a disposable/);
    assert.throws(() => assertDisposable("postgres://u:p@h:5432/precise"), /not named as a disposable/);
  });
});

describe("adopting an existing database", () => {
  // The one-time case that tripped staging: a database that predates the ledger has every
  // object already and no history recorded. Applying from 0001 fails on "already exists" —
  // safe, but the error describes the symptom rather than the fix.

  it("spots a populated schema with an empty ledger", () => {
    assert.equal(needsBaseline([], 42), true);
  });

  it("discounts the ledger migration, which creates itself", () => {
    // 0000 having run says nothing about whether the rest of the schema was recorded.
    assert.equal(needsBaseline(["0000_schema_migrations.sql"], 42), true);
  });

  it("leaves a genuinely empty database alone", () => {
    // A fresh database SHOULD apply from the start; that is not the adoption case.
    assert.equal(needsBaseline([], 0), false);
    assert.equal(needsBaseline(["0000_schema_migrations.sql"], 0), false);
  });

  it("says nothing once there is real history", () => {
    assert.equal(needsBaseline(["0000_schema_migrations.sql", "0001_core_schema.sql"], 42), false);
    assert.equal(needsBaseline(["0077_report_compositions.sql"], 42), false);
  });
});
