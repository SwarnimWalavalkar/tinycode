import { Kind, parse, type SelectionSetNode } from "graphql";

const queries = new Set(["viewer", "repository", "repositoryOwner", "user", "organization", "search", "node", "nodes", "rateLimit"]);

const mutations = new Set([
  "createPullRequest",
  "updatePullRequest",
  "closePullRequest",
  "reopenPullRequest",
  "mergePullRequest",
  "markPullRequestReadyForReview",
  "convertPullRequestToDraft",
  "addComment",
  "updateIssueComment",
  "deleteIssueComment",
  "addPullRequestReview",
  "submitPullRequestReview",
  "addPullRequestReviewComment",
  "resolveReviewThread",
  "unresolveReviewThread",
]);

export async function githubApiAllowed(request: Request): Promise<boolean> {
  const url = new URL(request.url);
  if (url.origin !== "https://api.github.com") return false;
  const path = url.pathname;
  const read = request.method === "GET" || request.method === "HEAD";
  if (path === "/graphql" && request.method === "POST") {
    try {
      const body = await request.clone().text();
      if (body.length > 1_000_000) return false;
      const { query } = JSON.parse(body);
      if (typeof query !== "string") return false;
      const document = parse(query, { maxTokens: 10000 });
      const fragments = new Map(
        document.definitions
          .filter((d) => d.kind === Kind.FRAGMENT_DEFINITION)
          .map((d) => [d.name.value, d]),
      );
      let expansionBudget = 10000;
      const memo = new Map<Set<string>, Map<string, boolean>>();
      function allowed(
        set: SelectionSetNode,
        fields: Set<string>,
        seen = new Set<string>(),
        depth = 0,
      ): boolean {
        if (depth > 128) return false;
        return set.selections.every((s) => {
          if (--expansionBudget < 0) return false;
          // A field is a root operation; its response selection is not another root.
          if (s.kind === Kind.FIELD) return fields.has(s.name.value);
          if (s.kind === Kind.INLINE_FRAGMENT)
            return allowed(s.selectionSet, fields, seen, depth + 1);
          const name = s.name.value;
          const fragment = fragments.get(name);
          if (!fragment || seen.has(name)) return false;
          let cache = memo.get(fields);
          if (!cache) { cache = new Map(); memo.set(fields, cache); }
          if (cache.has(name)) return cache.get(name)!;
          seen.add(name);
          const result = allowed(fragment.selectionSet, fields, seen, depth + 1);
          seen.delete(name);
          cache.set(name, result);
          return result;
        });
      }
      const operations = document.definitions.filter(
        (d) => d.kind === Kind.OPERATION_DEFINITION,
      );
      return (
        operations.length > 0 &&
        operations.every(
          (op) =>
            (op.operation === "query" && allowed(op.selectionSet, queries)) ||
            (op.operation === "mutation" && allowed(op.selectionSet, mutations)),
        )
      );
    } catch {
      return false;
    }
  }
  if (
    read &&
    /^\/(?:user(?:\/repos|\/orgs)?|orgs\/[^/]+\/repos|search\/(?:repositories|issues))$/.test(
      path,
    )
  )
    return true;
  const repo = path.match(/^\/repos\/[^/]+\/[^/]+(.*)$/);
  if (!repo) return false;
  const suffix = repo[1];
  if (
    read &&
    (suffix === "" ||
      /^\/(?:branches|commits|contents|git\/refs|git\/trees|git\/blobs)(?:\/.*)?$/.test(
        suffix,
      ))
  )
    return true;
  if (/^\/pulls(?:\/\d+)?$/.test(suffix))
    return read || request.method === "POST" || request.method === "PATCH";
  if (read && /^\/pulls\/\d+\/(?:commits|files)$/.test(suffix)) return true;
  if (/^\/pulls\/\d+\/merge$/.test(suffix))
    return read || request.method === "PUT";
  if (
    /^\/(?:pulls\/\d+\/(?:reviews|comments)(?:\/\d+(?:\/events|\/replies)?)?|pulls\/comments\/\d+|issues\/\d+\/comments|issues\/comments\/\d+)$/.test(
      suffix,
    )
  )
    return ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"].includes(
      request.method,
    );
  return false;
}
