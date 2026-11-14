import { gzipSync } from 'node:zlib';

import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { collectFusekiBackup, fusekiBackupKey } from './fuseki-backup.js';

// CronJob entry point: dump the registry dataset to the artifact bucket and
// report success/failure as Cachet/Watchdog/FusekiBackupSuccess (the alarm
// treats missing data as breaching, so a missed run is itself an incident).

const queryUrl = process.env['REGISTRY_SPARQL_QUERY_URL'] ?? '';
const dataUrl = queryUrl.replace(/\/sparql$/, '/data');
const username = process.env['REGISTRY_SPARQL_USERNAME'];
const password = process.env['REGISTRY_SPARQL_PASSWORD'];
const bucket = process.env['REGISTRY_S3_BUCKET'] ?? '';
const prefix = process.env['REGISTRY_S3_PREFIX'] ?? '';
const region = process.env['REGISTRY_S3_REGION'] ?? process.env['AWS_REGION'] ?? 'us-west-2';
const metricNamespace = process.env['FUSEKI_BACKUP_METRIC_NAMESPACE'] ?? 'Cachet/Watchdog';

async function publishMetric(value: number): Promise<void> {
  try {
    const client = new CloudWatchClient({ region });
    await client.send(
      new PutMetricDataCommand({
        Namespace: metricNamespace,
        MetricData: [
          { MetricName: 'FusekiBackupSuccess', Value: value, Unit: 'Count', Timestamp: new Date() },
        ],
      }),
    );
  } catch (err) {
    // Metric delivery must never mask the backup outcome itself.
    console.log(JSON.stringify({ metric_error: err instanceof Error ? err.message : String(err) }));
  }
}

async function main(): Promise<void> {
  if (!queryUrl || !bucket) {
    await publishMetric(0);
    console.error('fuseki backup misconfigured: REGISTRY_SPARQL_QUERY_URL and REGISTRY_S3_BUCKET are required');
    process.exit(1);
  }
  try {
    const collection = await collectFusekiBackup({
      queryUrl,
      dataUrl,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    });
    const body = gzipSync(Buffer.from(collection.nquads, 'utf8'));
    const key = fusekiBackupKey({ prefix });
    const s3 = new S3Client({ region });
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'application/n-quads',
        ContentEncoding: 'gzip',
        Metadata: {
          'named-graphs': String(collection.namedGraphs),
          lines: String(collection.lines),
        },
      }),
    );
    await publishMetric(1);
    console.log(
      JSON.stringify({
        ok: true,
        key: `s3://${bucket}/${key}`,
        gzip_bytes: body.byteLength,
        named_graphs: collection.namedGraphs,
        lines: collection.lines,
      }),
    );
  } catch (err) {
    await publishMetric(0);
    console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  }
}

await main();
