// Off-site backups of this API's database (src/dbbackup.ts). Runbook: docs/db-backups.md.
//   npm run db-backup -- run                    take a backup now (needs DATABASE_URL and pg_dump)
//   npm run db-backup -- list                   list the backups in the bucket
//   npm run db-backup -- fetch <key|latest> <file>   download and decrypt one to a pg_restore archive
// All three need SECRETS_KEY and the S3_* settings. list and fetch need no database.
import { writeFile } from 'node:fs/promises';
import { backupCipherKey, DbBackups, decryptBackup, latestBackupKey, loadDbBackupConfig, parseBackupKey, pgDump } from '../dbbackup.ts';
import { createPool, migrate } from '../db.ts';
import { S3 } from '../provisioner/s3.ts';

const [command, ...args] = process.argv.slice(2);
const config = loadDbBackupConfig(process.env);
const secretsKey = process.env.SECRETS_KEY;
if (!config || !secretsKey) {
  console.error('Set SECRETS_KEY and S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (and DB_BACKUP is not off)');
  process.exit(1);
}
const s3 = new S3(config.s3);
const cipherKey = backupCipherKey(secretsKey);

if (command === 'run') {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  await migrate(databaseUrl);
  const pool = createPool(databaseUrl);
  try {
    const { key, sizeBytes } = await new DbBackups(pool, s3, cipherKey, config, () => pgDump(databaseUrl)).run();
    console.log(`${key}\t${sizeBytes} bytes`);
  } finally {
    await pool.end();
  }
} else if (command === 'list') {
  const backups = (await s3.list(`${config.prefix}/`)).filter((o) => parseBackupKey(config.prefix, o.key));
  for (const { key, size } of backups.sort((a, b) => a.key.localeCompare(b.key))) console.log(`${key}\t${size}`);
} else if (command === 'fetch' && args.length === 2) {
  const key = args[0] === 'latest' ? await latestBackupKey(s3, config.prefix) : args[0]!;
  if (!key) throw new Error(`No backups under ${config.prefix}/`);
  const archive = decryptBackup(cipherKey, await s3.get(key));
  await writeFile(args[1]!, archive, { mode: 0o600 });
  console.log(`${key} -> ${args[1]} (${archive.length} bytes, pg_dump custom format)`);
} else {
  console.error('Usage: db-backup run | list | fetch <key|latest> <file>');
  process.exit(1);
}
