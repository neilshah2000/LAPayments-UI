// Build-time only: download the httpfs + aws extension binaries into DUCKDB_EXTENSION_DIR
// so the running container never contacts extensions.duckdb.org.
//
// Extension binaries are keyed by DuckDB version AND platform (the dev machine writes
// v1.5.5/osx_arm64/, a container writes v1.5.5/linux_arm64/), so this has to run inside the
// image it will be used in, built for the architecture it will be deployed on.
import { DuckDBInstance } from '@duckdb/node-api';

const dir = process.env.DUCKDB_EXTENSION_DIR;
if (!dir) throw new Error('DUCKDB_EXTENSION_DIR is not set');

const instance = await DuckDBInstance.create(':memory:', { extension_directory: dir });
const con = await instance.connect();

for (const ext of ['httpfs', 'aws']) {
  await con.run(`INSTALL ${ext}`);
  await con.run(`LOAD ${ext}`);
}

const rows = (
  await con.runAndReadAll(
    `SELECT extension_name, installed, loaded FROM duckdb_extensions() WHERE extension_name IN ('httpfs','aws') ORDER BY extension_name`,
  )
).getRowObjects();

// Fail the build here rather than the first s3:// read in production.
for (const r of rows) {
  if (!r.installed || !r.loaded) throw new Error(`${r.extension_name}: installed=${r.installed} loaded=${r.loaded}`);
}
const [{ version }] = (await con.runAndReadAll('SELECT version() AS version')).getRowObjects();
console.log(`duckdb ${version}: baked ${rows.map((r) => r.extension_name).join(', ')} into ${dir}`);
