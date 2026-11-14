export type SemanticTurkeyProject = {
  name: string;
};

export type SemanticTurkeyProjectsView = {
  status: 'configured' | 'not_configured' | 'error';
  projects: SemanticTurkeyProject[];
  detail?: string;
  raw?: unknown;
};

export interface SemanticTurkeyClient {
  listProjects(): Promise<SemanticTurkeyProjectsView>;
}

export class HttpSemanticTurkeyClient implements SemanticTurkeyClient {
  constructor(
    private readonly deps: {
      baseUrl?: string;
      email?: string;
      password?: string;
      fetchFn?: typeof fetch;
    },
  ) {}

  async listProjects(): Promise<SemanticTurkeyProjectsView> {
    if (!this.deps.baseUrl) {
      return { status: 'not_configured', projects: [], detail: 'Semantic Turkey base URL is not configured.' };
    }
    if (!this.deps.email || !this.deps.password) {
      return { status: 'not_configured', projects: [], detail: 'Semantic Turkey credentials are not configured.' };
    }

    try {
      const cookie = await this.login();
      const res = await (this.deps.fetchFn ?? fetch)(new URL('/Projects/listProjects', this.deps.baseUrl), {
        headers: {
          accept: 'application/json',
          cookie,
        },
      });
      const raw = await parseResponseBody(res);
      if (!res.ok) {
        return {
          status: 'error',
          projects: [],
          detail: `Semantic Turkey project request failed (${res.status}).`,
          raw,
        };
      }

      return {
        status: 'configured',
        projects: normalizeProjects(raw),
        raw,
      };
    } catch (err) {
      return {
        status: 'error',
        projects: [],
        detail: err instanceof Error ? err.message : 'Semantic Turkey request failed.',
      };
    }
  }

  private async login(): Promise<string> {
    const form = new URLSearchParams({
      email: this.deps.email ?? '',
      password: this.deps.password ?? '',
      _spring_security_remember_me: 'false',
    });
    const res = await (this.deps.fetchFn ?? fetch)(new URL('/Auth/login', this.deps.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
    });
    if (!res.ok) {
      throw new Error(`Semantic Turkey login failed (${res.status}).`);
    }

    const cookie = res.headers.get('set-cookie');
    if (!cookie) {
      throw new Error('Semantic Turkey login did not return a session cookie.');
    }
    return cookie;
  }
}

async function parseResponseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return await res.json();
  }
  return await res.text();
}

function normalizeProjects(raw: unknown): SemanticTurkeyProject[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => normalizeProjectItem(item));
  }
  if (raw && typeof raw === 'object') {
    const projects = (raw as Record<string, unknown>)['projects'];
    if (Array.isArray(projects)) {
      return projects.flatMap((item) => normalizeProjectItem(item));
    }
    const value = (raw as Record<string, unknown>)['value'];
    if (Array.isArray(value)) {
      return value.flatMap((item) => normalizeProjectItem(item));
    }
  }
  return [];
}

function normalizeProjectItem(item: unknown): SemanticTurkeyProject[] {
  if (typeof item === 'string') {
    return [{ name: item }];
  }
  if (!item || typeof item !== 'object') {
    return [];
  }
  const obj = item as Record<string, unknown>;
  const name = typeof obj['name'] === 'string'
    ? obj['name']
    : typeof obj['projectName'] === 'string'
      ? obj['projectName']
      : typeof obj['label'] === 'string'
        ? obj['label']
        : undefined;
  return name ? [{ name }] : [];
}
