// Daily Fuseki backup: exports every graph of the registry dataset as a
// single N-Quads document into the versioned artifacts bucket, and publishes
// Cachet/Watchdog/FusekiBackupSuccess so a missed or failed day alarms
// (missing data is breaching on the Terraform alarm).
//
// Runs as a CronJob in the tessera-sidecar image (AWS SDK deps + the
// release service account's IRSA grant for the artifact bucket).

export type FusekiBackupCollection = {
  nquads: string;
  namedGraphs: number;
  lines: number;
};

function basicAuthHeader(username?: string, password?: string): Record<string, string> {
  if (!username) return {};
  const token = Buffer.from(`${username}:${password ?? ''}`, 'utf8').toString('base64');
  return { authorization: `Basic ${token}` };
}

// Lists named graphs via SPARQL then pulls the default graph and every named
// graph through the graph store protocol, assembling N-Quads.
export async function collectFusekiBackup(input: {
  queryUrl: string;
  dataUrl: string;
  username?: string | undefined;
  password?: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<FusekiBackupCollection> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 15000;
  const headers = { accept: 'application/json', ...basicAuthHeader(input.username, input.password) };

  const listResponse = await fetchImpl(input.queryUrl, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      query: 'SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }',
      format: 'application/sparql-results+json',
    }).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!listResponse.ok) {
    throw new Error(`fuseki graph listing failed (${listResponse.status})`);
  }
  const listing = (await listResponse.json()) as { results?: { bindings?: Array<{ g?: { value?: string } }> } };
  const graphs = (listing.results?.bindings ?? [])
    .map((row) => row.g?.value)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort();

  const sections: string[] = [];
  const chunk = async (url: string, accept: string): Promise<void> => {
    const response = await fetchImpl(url, {
      headers: { accept, ...basicAuthHeader(input.username, input.password) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`fuseki graph fetch failed (${response.status}) for ${url}`);
    }
    const text = await response.text();
    if (text.trim().length > 0) sections.push(text.endsWith('\n') ? text : `${text}\n`);
  };

  // Default graph first, then every named graph as N-Quads.
  await chunk(input.dataUrl, 'application/n-triples');
  for (const graph of graphs) {
    await chunk(`${input.dataUrl}?graph=${encodeURIComponent(graph)}`, 'application/n-quads');
  }

  const nquads = sections.join('');
  return {
    nquads,
    namedGraphs: graphs.length,
    lines: nquads.split('\n').filter((line) => line.trim().length > 0).length,
  };
}

export function fusekiBackupKey(input: { prefix: string; date?: Date }): string {
  const date = input.date ?? new Date();
  const day = date.toISOString().slice(0, 10);
  const prefix = input.prefix.replace(/^\/+|\/+$/g, '');
  return `${prefix}/backups/fuseki/${day}.nq.gz`;
}
