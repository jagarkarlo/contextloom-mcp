import { type ServiceConnection, trimTrailingSlash } from './client.js';

export interface GitLabInstance extends ServiceConnection {
  name: string;
}

/**
 * A single GITLAB_BASE_URL/GITLAB_TOKEN pair by default, or several instances via
 * GITLAB_INSTANCES=[{"name":"...", "baseUrl":"...", "token":"..."}] for anyone working
 * across more than one GitLab host (gitlab.com plus a self-hosted instance, for example).
 */
export function loadGitLabInstances(environment: NodeJS.ProcessEnv): GitLabInstance[] {
  const raw = environment.GITLAB_INSTANCES?.trim();
  if (raw) {
    const parsed = JSON.parse(raw) as Array<{ name: string; baseUrl: string; token: string }>;
    if (parsed.length === 0) {
      throw new Error('GITLAB_INSTANCES is set but contains no entries');
    }
    return parsed.map((entry) => ({
      name: entry.name,
      baseUrl: trimTrailingSlash(entry.baseUrl),
      token: entry.token
    }));
  }

  const baseUrl = environment.GITLAB_BASE_URL;
  const token = environment.GITLAB_TOKEN;
  if (!baseUrl || !token) {
    throw new Error(
      'Missing GitLab configuration: set GITLAB_BASE_URL and GITLAB_TOKEN, or GITLAB_INSTANCES for multiple hosts'
    );
  }
  return [{ name: 'default', baseUrl: trimTrailingSlash(baseUrl), token }];
}

export function selectGitLabInstance(
  instances: GitLabInstance[],
  name: string | undefined
): GitLabInstance {
  if (!name) return instances[0]!;
  const match = instances.find((instance) => instance.name === name);
  if (!match) {
    const available = instances.map((instance) => instance.name).join(', ');
    throw new Error(`Unknown GitLab instance "${name}". Configured instances: ${available}`);
  }
  return match;
}
