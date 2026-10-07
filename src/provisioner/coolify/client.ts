/** The parts of Coolify's API (v4.3) the driver uses. */

export interface CoolifyService {
  uuid: string;
  name: string;
  description?: string | null;
  environment_id?: number;
  status?: string;
  applications?: { name: string; status?: string }[];
  databases?: { name: string; status?: string }[];
}

export interface CoolifyEnv {
  uuid: string;
  key: string;
  value?: string;
  real_value?: string;
}

export interface CoolifyTaskExecution {
  uuid: string;
  status: string;
  message?: string | null;
  finished_at?: string | null;
}

export class CoolifyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class CoolifyClient {
  private readonly base: string;

  constructor(
    url: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `${url.replace(/\/$/, '')}/api/v1`;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) {
      // Coolify's error bodies carry a message and validation errors, never the request body.
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text);
        message = [parsed.message, parsed.errors && JSON.stringify(parsed.errors)].filter(Boolean).join(' ') || message;
      } catch {
        // not JSON; keep the start of the text
      }
      throw new CoolifyError(res.status, `Coolify ${method} ${path.replace(/\?.*/, '')}: HTTP ${res.status} ${message}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  getEnvironment(projectUuid: string, name: string) {
    return this.request<{ id: number; uuid: string; name: string }>('GET', `/projects/${projectUuid}/${encodeURIComponent(name)}`);
  }

  createEnvironment(projectUuid: string, name: string) {
    return this.request<{ uuid: string }>('POST', `/projects/${projectUuid}/environments`, { name });
  }

  listServices() {
    return this.request<CoolifyService[]>('GET', '/services');
  }

  getService(uuid: string) {
    return this.request<CoolifyService>('GET', `/services/${uuid}`);
  }

  createService(body: {
    name: string;
    description: string;
    project_uuid: string;
    environment_name: string;
    server_uuid: string;
    docker_compose_raw: string;
    urls: { name: string; url: string }[];
    instant_deploy: boolean;
  }) {
    return this.request<{ uuid: string; domains?: string[] }>('POST', '/services', body);
  }

  updateService(uuid: string, body: { description?: string; docker_compose_raw?: string; urls?: { name: string; url: string }[] }) {
    return this.request<{ uuid: string }>('PATCH', `/services/${uuid}`, body);
  }

  deleteService(uuid: string) {
    const q = 'delete_configurations=true&delete_volumes=true&docker_cleanup=true&delete_connected_networks=true';
    return this.request<unknown>('DELETE', `/services/${uuid}?${q}`);
  }

  startService(uuid: string) {
    return this.request<unknown>('POST', `/services/${uuid}/start`);
  }

  restartService(uuid: string) {
    return this.request<unknown>('POST', `/services/${uuid}/restart`);
  }

  listEnvs(uuid: string) {
    return this.request<CoolifyEnv[]>('GET', `/services/${uuid}/envs`);
  }

  setEnvs(uuid: string, envs: Record<string, string>) {
    const data = Object.entries(envs).map(([key, value]) => ({ key, value, is_literal: true }));
    return this.request<CoolifyEnv[]>('PATCH', `/services/${uuid}/envs/bulk`, { data });
  }

  deleteEnv(uuid: string, envUuid: string) {
    return this.request<unknown>('DELETE', `/services/${uuid}/envs/${envUuid}`);
  }

  createTask(uuid: string, task: { name: string; command: string; container: string; frequency: string; timeout: number; enabled: boolean }) {
    return this.request<{ uuid: string }>('POST', `/services/${uuid}/scheduled-tasks`, task);
  }

  executeTask(uuid: string, taskUuid: string) {
    return this.request<unknown>('POST', `/services/${uuid}/scheduled-tasks/${taskUuid}/execute`);
  }

  listExecutions(uuid: string, taskUuid: string) {
    return this.request<CoolifyTaskExecution[]>('GET', `/services/${uuid}/scheduled-tasks/${taskUuid}/executions`);
  }

  deleteTask(uuid: string, taskUuid: string) {
    return this.request<unknown>('DELETE', `/services/${uuid}/scheduled-tasks/${taskUuid}`);
  }
}
