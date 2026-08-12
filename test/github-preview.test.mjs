import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { beforeEach, describe, it } from "node:test";

import {
  extractLinkPreview,
  fetchGitHubRepositoryInfo,
  getLinkPreviewStatus,
  isGitHubRepositoryUrl,
  normalizeGitHubRepository,
  parseGitHubRepositoryUrl,
  resetGitHubPreviewCache,
  resetLinkPreviewStatus,
} from "../bridge/services/link-preview/index.mjs";

beforeEach(() => {
  resetGitHubPreviewCache();
  resetLinkPreviewStatus();
});

describe("GitHub repository URL parsing", () => {
  it("recognizes repository and nested repository pages", () => {
    assert.deepEqual(parseGitHubRepositoryUrl("https://github.com/octocat/Hello-World"), {
      owner: "octocat",
      repo: "Hello-World",
      fullName: "octocat/Hello-World",
      key: "octocat/hello-world",
      url: "https://github.com/octocat/Hello-World",
    });
    assert.equal(
      parseGitHubRepositoryUrl("https://github.com/octocat/Hello-World/tree/main/src").fullName,
      "octocat/Hello-World"
    );
    assert.equal(
      parseGitHubRepositoryUrl("https://github.com/octocat/Hello-World.git").repo,
      "Hello-World"
    );
  });

  it("does not mistake GitHub navigation or other hosts for repositories", () => {
    assert.equal(isGitHubRepositoryUrl("https://github.com/features/actions"), false);
    assert.equal(isGitHubRepositoryUrl("https://github.com/topics/javascript"), false);
    assert.equal(isGitHubRepositoryUrl("https://gist.github.com/octocat/example"), false);
    assert.equal(isGitHubRepositoryUrl("http://github.com/octocat/Hello-World"), false);
  });
});

describe("GitHub repository metadata", () => {
  it("formats a compact Chinese repository card", () => {
    const repository = parseGitHubRepositoryUrl("https://github.com/octocat/Hello-World");
    const preview = normalizeGitHubRepository(sampleRepository(), repository);
    assert.equal(preview.text, [
      "GitHub · octocat/Hello-World",
      "A small example repository.",
      "",
      "JavaScript · Stars 1.2k · Forks 56",
      "MIT 许可证 · 模板仓库 · 更新于 2026-08-09",
      "#example  #api",
    ].join("\n"));
    assert.equal(preview.image, "https://opengraph.githubassets.com/1/octocat/Hello-World");
    assert.equal(preview.githubRepository, "octocat/Hello-World");
  });

  it("omits empty descriptions and limits topics to three", () => {
    const repository = parseGitHubRepositoryUrl("https://github.com/octocat/Hello-World");
    const preview = normalizeGitHubRepository({
      ...sampleRepository(),
      description: null,
      topics: ["one", "two words", "three", "four"],
      is_template: false,
      fork: true,
    }, repository);
    assert.match(preview.text, /^GitHub · octocat\/Hello-World\n\nJavaScript/);
    assert.match(preview.text, /MIT 许可证 · Fork · 更新于 2026-08-09/);
    assert.match(preview.text, /#one {2}#two-words {2}#three$/);
    assert.doesNotMatch(preview.text, /暂无|#four/);
    assert.equal(preview.description, "");
  });

  it("separates only important repository state warnings", () => {
    const repository = parseGitHubRepositoryUrl("https://github.com/octocat/Hello-World");
    const preview = normalizeGitHubRepository({
      ...sampleRepository(),
      archived: true,
      disabled: true,
    }, repository);
    assert.match(preview.text, /\n\n注意：该仓库已归档并停用。$/);
  });

  it("does not expose private repository metadata", () => {
    const repository = parseGitHubRepositoryUrl("https://github.com/octocat/private-repo");
    assert.equal(normalizeGitHubRepository({ ...sampleRepository(), private: true }, repository), null);
  });

  it("caches equivalent repository links", async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      return sampleRepository();
    };
    const first = await fetchGitHubRepositoryInfo("https://github.com/octocat/Hello-World/tree/main", {
      loader,
      now: 1000,
    });
    const second = await fetchGitHubRepositoryInfo("https://github.com/octocat/Hello-World", {
      loader,
      now: 2000,
    });
    assert.equal(first.githubRepository, second.githubRepository);
    assert.equal(calls, 1);
  });
});

describe("unified GitHub link preview routing", () => {
  it("uses GitHub repository metadata before generic HTML", async () => {
    await withMockFetch(async url => {
      assert.match(String(url), /^https:\/\/api\.github\.com\/repos\/octocat\/Hello-World/);
      return jsonResponse(sampleRepository());
    }, async () => {
      const preview = await extractLinkPreview("https://github.com/octocat/Hello-World");
      assert.equal(preview.githubRepository, "octocat/Hello-World");
    });
    const status = getLinkPreviewStatus();
    assert.equal(status.hits, 1);
    assert.equal(status.githubHits, 1);
    assert.equal(status.genericHits, 0);
  });

  it("falls back to generic page metadata when the GitHub API is unavailable", async () => {
    let calls = 0;
    await withMockFetch(async () => {
      calls++;
      if (calls === 1) return emptyResponse(403, "application/json");
      return textResponse("<title>Fallback Repository Page</title>");
    }, async () => {
      const preview = await extractLinkPreview("https://github.com/octocat/Fallback-Repo");
      assert.equal(preview.title, "Fallback Repository Page");
      assert.equal(preview.githubRepository, undefined);
    });
    const status = getLinkPreviewStatus();
    assert.equal(status.hits, 1);
    assert.equal(status.githubHits, 0);
    assert.equal(status.genericHits, 1);
  });
});

function sampleRepository() {
  return {
    private: false,
    full_name: "octocat/Hello-World",
    description: "A small example repository.",
    language: "JavaScript",
    stargazers_count: 1234,
    forks_count: 56,
    license: { spdx_id: "MIT", name: "MIT License" },
    topics: ["example", "api"],
    updated_at: "2026-08-09T12:00:00Z",
    is_template: true,
  };
}

async function withMockFetch(mockFetch, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(value) {
  const body = Buffer.from(JSON.stringify(value));
  return {
    ok: true,
    status: 200,
    headers: headerMap({ "content-type": "application/json", "content-length": String(body.length) }),
    arrayBuffer: async () => body,
  };
}

function textResponse(value) {
  return {
    ok: true,
    status: 200,
    headers: headerMap({ "content-type": "text/html; charset=utf-8" }),
    text: async () => value,
  };
}

function emptyResponse(status, contentType) {
  return {
    ok: false,
    status,
    headers: headerMap({ "content-type": contentType }),
  };
}

function headerMap(values) {
  return {
    get: name => values[String(name || "").toLowerCase()] || null,
  };
}
