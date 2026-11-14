import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

import { checkSidecar } from './watchdog.js';

// CronJob entry point: probe the sidecar and publish Cachet/Watchdog/
// SidecarHealthy for the Terraform alarm.

const url =
  process.env['TESSERA_SIDECAR_WATCHDOG_URL'] ?? `http://127.0.0.1:${process.env['PORT'] ?? '3400'}`;
const token = process.env['TESSERA_SIDECAR_AUTH_TOKEN'];
const namespace = process.env['TESSERA_SIDECAR_WATCHDOG_NAMESPACE'] ?? 'Cachet/Watchdog';
const region = process.env['AWS_REGION'] ?? process.env['TESSERA_SIDECAR_REGION'] ?? 'us-west-2';

const result = await checkSidecar({ url, token });
const client = new CloudWatchClient({ region });
await client.send(
  new PutMetricDataCommand({
    Namespace: namespace,
    MetricData: [
      {
        MetricName: 'SidecarHealthy',
        Value: result.healthy ? 1 : 0,
        Unit: 'Count',
        Timestamp: new Date(),
      },
    ],
  }),
);
console.log(JSON.stringify({ healthy: result.healthy, detail: result.detail, url }));
// Non-zero exit keeps failures visible in job history; alerting is the metric.
process.exit(result.healthy ? 0 : 1);
