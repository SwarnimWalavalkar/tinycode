import { describe, expect, it } from "vitest";
import { githubApiAllowed } from "./github-policy.js";
const api = (path: string, method = "POST", query?: string) =>
  githubApiAllowed(
    new Request(`https://api.github.com${path}`, {
      method,
      ...(query ? { body: JSON.stringify({ query }) } : {}),
    }),
  );
describe("sandbox GitHub API policy", () => {
  it("denies delegated credentials and repository administration", async () => {
    for (const path of [
      "keys",
      "hooks",
      "collaborators/attacker",
      "actions/runners/registration-token",
      "actions/runners/remove-token",
      "actions/runners/generate-jitconfig",
      "invitations",
    ]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "GET"])
        expect(await api(`/repos/org/repo/${path}`, method)).toBe(false);
    }
  });
  it("supports repository discovery and PR operations", async () => {
    expect(await api("/repos/org/repo", "GET")).toBe(true);
    expect(await api("/repos/org/repo/pulls")).toBe(true);
    expect(await api("/repos/org/repo/pulls/3", "PATCH")).toBe(true);
    expect(
      await api(
        "/graphql",
        "POST",
        'query { repository(owner: "org", name: "repo") { id } }',
      ),
    ).toBe(true);
    expect(
      await api(
        "/graphql",
        "POST",
        "mutation { createPullRequest(input: {}) { pullRequest { id } } }",
      ),
    ).toBe(true);
  });
  it("checks actual mutation fields through aliases and fragments, including unused operations", async () => {
    for (const query of [
      "mutation { createPullRequest: createRepository(input: {}) { clientMutationId } }",
      "mutation { ...Admin } fragment Admin on Mutation { createRepository(input: {}) { clientMutationId } }",
      "query Safe { viewer { login } } mutation Bad { deleteRepository(input: {}) { clientMutationId } }",
      "mutation { ...Loop } fragment Loop on Mutation { ...Loop }",
      "not graphql",
    ])
      expect(await api("/graphql", "POST", query)).toBe(false);
  });
});
