import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import {
  fetchBearerApi,
  fetchGitHub,
  fetchGitLab,
  githubContentPath,
  githubFileRequest,
  githubRepositoryPath,
  fetchJira,
  jiraCommentRequest,
  jiraWorklogRequestWithStart,
  optionalConnection,
  optionalGitHubConnection,
  requiredEnvironment,
  textResult,
  trimTrailingSlash,
  type ServiceConnection
} from './client.js';
import { loadGitLabInstances, selectGitLabInstance } from './config.js';
import { rememberSecret } from './redact.js';

loadEnv();

const gitlabInstances = loadGitLabInstances(process.env);
const instanceSchema =
  gitlabInstances.length > 1
    ? z
        .string()
        .min(1)
        .describe(`One of the configured GitLab instances: ${gitlabInstances.map((i) => i.name).join(', ')}`)
        .optional()
    : z.string().min(1).optional();

function gitlab(instance?: string): ServiceConnection {
  return selectGitLabInstance(gitlabInstances, instance);
}

const jira: ServiceConnection = {
  baseUrl: trimTrailingSlash(requiredEnvironment(process.env, 'JIRA_BASE_URL')),
  token: requiredEnvironment(process.env, 'JIRA_API_TOKEN')
};
const confluence = optionalConnection(process.env, 'CONFLUENCE_BASE_URL', 'CONFLUENCE_API_TOKEN');
const grafana = optionalConnection(process.env, 'GRAFANA_BASE_URL', 'GRAFANA_API_TOKEN');
const github = optionalGitHubConnection(process.env);

for (const connection of [...gitlabInstances, jira, confluence, grafana, github]) {
  rememberSecret(connection?.token);
}

function requiredIntegration(
  connection: ServiceConnection | undefined,
  name: string
): ServiceConnection {
  if (!connection) {
    throw new Error(`${name} is not configured. Set its base URL and API token to enable these tools.`);
  }

  return connection;
}

function requiredGitHubIntegration() {
  if (!github) {
    throw new Error('GitHub is not configured. Set GITHUB_TOKEN to enable GitHub tools.');
  }

  return github;
}

const server = new McpServer({
  name: 'contextloom',
  version: '0.3.0'
});

const jiraIssueKey = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*-\d+$/, 'Use an uppercase Jira issue key, for example PROJECT-123.');
const jiraDuration = z
  .string()
  .regex(/^\d+[wdhm](?:\s+\d+[wdhm])*$/, 'Use Jira duration syntax, for example 1h 30m.');

server.registerTool(
  'gitlab_list_projects',
  {
    description: 'List GitLab projects visible to the configured token.',
    inputSchema: {
      instance: instanceSchema,
      limit: z.number().int().min(1).max(100).default(20)
    }
  },
  async ({ instance, limit }) =>
    textResult(
      await fetchGitLab(gitlab(instance), `/api/v4/projects?simple=true&membership=true&per_page=${limit}`)
    )
);

server.registerTool(
  'gitlab_get_project',
  {
    description: 'Get a GitLab project by numeric ID or URL-encoded path.',
    inputSchema: { instance: instanceSchema, project: z.string().min(1) }
  },
  async ({ instance, project }) =>
    textResult(await fetchGitLab(gitlab(instance), `/api/v4/projects/${encodeURIComponent(project)}`))
);

server.registerTool(
  'gitlab_list_merge_requests',
  {
    description: 'List GitLab merge requests visible to the configured token.',
    inputSchema: {
      instance: instanceSchema,
      project: z.string().min(1).optional(),
      scope: z.enum(['created_by_me', 'assigned_to_me', 'all']).default('created_by_me'),
      state: z.enum(['opened', 'closed', 'locked', 'merged', 'all']).default('all'),
      limit: z.number().int().min(1).max(100).default(20)
    }
  },
  async ({ instance, project, scope, state, limit }) => {
    const query = `scope=${scope}&state=${state}&order_by=updated_at&sort=desc&per_page=${limit}`;
    const path = project
      ? `/api/v4/projects/${encodeURIComponent(project)}/merge_requests?${query}`
      : `/api/v4/merge_requests?${query}`;
    return textResult(await fetchGitLab(gitlab(instance), path));
  }
);

server.registerTool(
  'gitlab_get_merge_request',
  {
    description: 'Get one GitLab merge request and its metadata.',
    inputSchema: {
      instance: instanceSchema,
      project: z.string().min(1),
      mergeRequestIid: z.number().int().positive()
    }
  },
  async ({ instance, project, mergeRequestIid }) =>
    textResult(
      await fetchGitLab(
        gitlab(instance),
        `/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${mergeRequestIid}`
      )
    )
);

server.registerTool(
  'gitlab_list_pipelines',
  {
    description: 'List recent CI/CD pipelines for a GitLab project.',
    inputSchema: {
      instance: instanceSchema,
      project: z.string().min(1),
      ref: z.string().min(1).optional(),
      status: z.enum(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'success', 'failed', 'canceled', 'skipped', 'manual', 'scheduled']).optional(),
      limit: z.number().int().min(1).max(100).default(20)
    }
  },
  async ({ instance, project, ref, status, limit }) => {
    const query = new URLSearchParams({ per_page: String(limit) });
    if (ref) query.set('ref', ref);
    if (status) query.set('status', status);
    return textResult(
      await fetchGitLab(gitlab(instance), `/api/v4/projects/${encodeURIComponent(project)}/pipelines?${query}`)
    );
  }
);

server.registerTool(
  'gitlab_get_file',
  {
    description: 'Read one file from a GitLab repository at a branch, tag, or commit ref.',
    inputSchema: {
      instance: instanceSchema,
      project: z.string().min(1),
      path: z.string().min(1),
      ref: z.string().min(1).default('HEAD')
    }
  },
  async ({ instance, project, path, ref }) =>
    textResult(
      await fetchGitLab(
        gitlab(instance),
        `/api/v4/projects/${encodeURIComponent(project)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`
      )
    )
);

server.registerTool(
  'github_get_authenticated_user',
  {
    description: 'Get the authenticated GitHub user. Use this to verify GITHUB_TOKEN access.',
    inputSchema: {}
  },
  async () => textResult(await fetchGitHub(requiredGitHubIntegration(), '/user'))
);

server.registerTool(
  'github_list_repositories',
  {
    description: 'List repositories accessible to the configured GitHub token.',
    inputSchema: {
      visibility: z.enum(['all', 'public', 'private']).default('all'),
      limit: z.number().int().min(1).max(100).default(30)
    }
  },
  async ({ visibility, limit }) =>
    textResult(
      await fetchGitHub(
        requiredGitHubIntegration(),
        `/user/repos?visibility=${visibility}&affiliation=owner,collaborator&per_page=${limit}&sort=updated`
      )
    )
);

server.registerTool(
  'github_get_repository',
  {
    description: 'Get metadata for a GitHub repository using owner/name.',
    inputSchema: { repository: z.string().regex(/^[^/]+\/[^/]+$/, 'Use owner/repository.') }
  },
  async ({ repository }) =>
    textResult(await fetchGitHub(requiredGitHubIntegration(), githubRepositoryPath(repository)))
);

server.registerTool(
  'github_get_file_content',
  {
    description: 'Read one text file from a GitHub repository and branch or ref.',
    inputSchema: {
      repository: z.string().regex(/^[^/]+\/[^/]+$/, 'Use owner/repository.'),
      path: z.string().min(1),
      ref: z.string().min(1).default('HEAD')
    }
  },
  async ({ repository, path, ref }) =>
    textResult(
      await fetchGitHub(
        requiredGitHubIntegration(),
        `${githubContentPath(repository, path)}?ref=${encodeURIComponent(ref)}`
      )
    )
);

server.registerTool(
  'github_create_or_update_file',
  {
    description:
      'Create or update exactly one UTF-8 text file on GitHub. Requires confirm: true. For updates, supply the file SHA returned by github_get_file_content to prevent overwriting newer changes.',
    inputSchema: {
      repository: z.string().regex(/^[^/]+\/[^/]+$/, 'Use owner/repository.'),
      path: z.string().min(1),
      content: z.string(),
      message: z.string().min(1).max(250),
      branch: z.string().min(1).optional(),
      sha: z.string().min(1).optional(),
      confirm: z.literal(true).describe('Must be true to confirm this repository write.')
    }
  },
  async ({ repository, path, content, message, branch, sha }) =>
    textResult(
      await fetchGitHub(
        requiredGitHubIntegration(),
        githubContentPath(repository, path),
        githubFileRequest(content, message, branch, sha)
      )
    )
);

server.registerTool(
  'jira_get_my_issues',
  {
    description: 'List Jira issues assigned to the authenticated user.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) }
  },
  async ({ limit }) => {
    const jql = encodeURIComponent('assignee = currentUser() ORDER BY updated DESC');
    return textResult(
      await fetchJira(
        jira,
        `/rest/api/2/search?jql=${jql}&maxResults=${limit}&fields=summary,status,assignee,updated,issuetype,priority,project`
      )
    );
  }
);

server.registerTool(
  'jira_get_issue',
  {
    description: 'Get a Jira issue by key, including comments.',
    inputSchema: { issueKey: jiraIssueKey }
  },
  async ({ issueKey }) =>
    textResult(
      await fetchJira(
        jira,
        `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,assignee,reporter,comment,issuetype,priority,project,labels,updated`
      )
    )
);

server.registerTool(
  'jira_search_issues',
  {
    description: 'Search Jira issues using JQL. This tool is read-only.',
    inputSchema: {
      jql: z.string().min(1),
      startAt: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(20)
    }
  },
  async ({ jql, startAt, limit }) =>
    textResult(
      await fetchJira(
        jira,
        `/rest/api/2/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${limit}&fields=summary,status,assignee,updated,issuetype,priority,project,labels`
      )
    )
);

server.registerTool(
  'jira_list_comments',
  {
    description: 'List comments on a Jira issue.',
    inputSchema: {
      issueKey: jiraIssueKey,
      startAt: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(100)
    }
  },
  async ({ issueKey, startAt, limit }) =>
    textResult(
      await fetchJira(
        jira,
        `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment?startAt=${startAt}&maxResults=${limit}`
      )
    )
);

server.registerTool(
  'jira_list_worklogs',
  {
    description: 'List worklog entries on a Jira issue.',
    inputSchema: {
      issueKey: jiraIssueKey,
      startAt: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(100)
    }
  },
  async ({ issueKey, startAt, limit }) =>
    textResult(
      await fetchJira(
        jira,
        `/rest/api/2/issue/${encodeURIComponent(issueKey)}/worklog?startAt=${startAt}&maxResults=${limit}`
      )
    )
);

server.registerTool(
  'jira_get_transitions',
  {
    description: 'List the status transitions currently available for a Jira issue.',
    inputSchema: { issueKey: jiraIssueKey }
  },
  async ({ issueKey }) =>
    textResult(await fetchJira(jira, `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`))
);

server.registerTool(
  'jira_get_changelog',
  {
    description: 'Get the status and field change history for a Jira issue.',
    inputSchema: { issueKey: jiraIssueKey }
  },
  async ({ issueKey }) =>
    textResult(
      await fetchJira(
        jira,
        `/rest/api/2/issue/${encodeURIComponent(issueKey)}?expand=changelog&fields=none`
      )
    )
);

server.registerTool(
  'jira_add_comment',
  {
    description: 'Add a plain-text comment to a Jira issue. Requires explicit confirmation.',
    inputSchema: {
      issueKey: jiraIssueKey,
      comment: z.string().min(1),
      confirm: z.literal(true).describe('Must be true to confirm this Jira write.')
    }
  },
  async ({ issueKey, comment }) =>
    textResult(
      await fetchJira(
        jira,
        `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`,
        jiraCommentRequest(comment)
      )
    )
);

server.registerTool(
  'jira_add_worklog',
  {
    description: 'Add a worklog entry to a Jira issue. Requires explicit confirmation.',
    inputSchema: {
      issueKey: jiraIssueKey,
      timeSpent: jiraDuration,
      comment: z.string().min(1).optional(),
      started: z.string().datetime({ offset: true }).optional(),
      confirm: z.literal(true).describe('Must be true to confirm this Jira write.')
    }
  },
  async ({ issueKey, timeSpent, comment, started }) =>
    textResult(
      await fetchJira(
        jira,
        `/rest/api/2/issue/${encodeURIComponent(issueKey)}/worklog`,
        jiraWorklogRequestWithStart(timeSpent, comment, started)
      )
    )
);

server.registerTool(
  'confluence_get_page',
  {
    description: 'Get a Confluence page by numeric page ID, including stored page content.',
    inputSchema: { pageId: z.string().min(1) }
  },
  async ({ pageId }) =>
    textResult(
      await fetchBearerApi(
        'Confluence',
        requiredIntegration(confluence, 'Confluence'),
        `/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage,version,space`
      )
    )
);

server.registerTool(
  'confluence_search',
  {
    description: 'Search Confluence content with a CQL query.',
    inputSchema: {
      cql: z.string().min(1),
      limit: z.number().int().min(1).max(100).default(20)
    }
  },
  async ({ cql, limit }) =>
    textResult(
      await fetchBearerApi(
        'Confluence',
        requiredIntegration(confluence, 'Confluence'),
        `/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=space`
      )
    )
);

server.registerTool(
  'grafana_search_dashboards',
  {
    description: 'Search Grafana dashboards visible to the configured service account.',
    inputSchema: {
      query: z.string().default(''),
      limit: z.number().int().min(1).max(1000).default(20)
    }
  },
  async ({ query, limit }) =>
    textResult(
      await fetchBearerApi(
        'Grafana',
        requiredIntegration(grafana, 'Grafana'),
        `/api/search?query=${encodeURIComponent(query)}&limit=${limit}`
      )
    )
);

server.registerTool(
  'grafana_get_dashboard',
  {
    description: 'Get a Grafana dashboard by UID.',
    inputSchema: { uid: z.string().min(1) }
  },
  async ({ uid }) =>
    textResult(
      await fetchBearerApi(
        'Grafana',
        requiredIntegration(grafana, 'Grafana'),
        `/api/dashboards/uid/${encodeURIComponent(uid)}`
      )
    )
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
