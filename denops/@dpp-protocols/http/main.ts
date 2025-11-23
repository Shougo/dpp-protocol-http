import type { Plugin, ProtocolOptions } from "@shougo/dpp-vim/types";
import { BaseProtocol } from "@shougo/dpp-vim/protocol";
import { assertEquals } from "@std/assert/equals";

import type { Denops } from "@denops/std";
import * as vars from "@denops/std/variable";

export type Params = Record<string, never>;

export type Attrs = Record<string, never>;

export class Protocol extends BaseProtocol<Params> {
  override async detect(args: {
    denops: Denops;
    plugin: Plugin;
    protocolOptions: ProtocolOptions;
    protocolParams: Params;
  }): Promise<Partial<Plugin> | undefined> {
    if (!args.plugin.repo || !args.plugin.repo.match(/^https?:\/\//)) {
      return;
    }

    if (
      !args.plugin.repo.match(
        /\/\/(raw|gist)\.githubusercontent\.com\/|\/archive\/[^\/]+.zip$/,
      )
    ) {
      // Raw repository
      return;
    }

    const url = args.plugin.repo;

    return {
      path: `${await vars.g.get(
        args.denops,
        "dpp#_base_path",
      )}/repos/${getDirectoryName(url)}`,
      url,
    };
  }

  override params(): Params {
    return {};
  }
}

export function getDirectoryName(url: string): string {
  const removeExt = (name: string) => {
    const exts = [
      ".tar.gz",
      ".tar.bz2",
      ".tar.xz",
      ".tar",
      ".tgz",
      ".zip",
      ".gz",
      ".bz2",
    ];
    const lower = name.toLowerCase();
    for (const e of exts) {
      if (lower.endsWith(e)) return name.slice(0, -e.length);
    }
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(0, i) : name;
  };

  const stripHexRef = (name: string) => {
    // Remove trailing -<hexcommit> if present (7+ hex chars)
    return name.replace(/-[0-9a-f]{7,40}$/i, "");
  };

  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const segs = u.pathname.split("/").filter(Boolean);

    // raw content URLs -> use filename without extension
    if (host === "raw.githubusercontent.com" && segs.length > 0) {
      return removeExt(segs[segs.length - 1]);
    }

    // If there's an "archive" segment, handle both GitHub and GitLab patterns:
    // - GitHub: /owner/repo/archive/...
    // - GitLab: /owner/repo/-/archive/...
    const archiveIdx = segs.indexOf("archive");
    if (archiveIdx > 0) {
      // if the segment before "archive" is "-" (gitlab), repo is two segments
      // before
      if (segs[archiveIdx - 1] === "-" && archiveIdx - 2 >= 0) {
        return segs[archiveIdx - 2];
      }
      return segs[archiveIdx - 1];
    }

    // Bitbucket: /owner/repo/get/...
    if (host.includes("bitbucket.org") && segs.length >= 2) {
      return segs[1];
    }

    // GitLab general case: /owner/repo/...
    if (host.includes("gitlab.com") && segs.length >= 2) {
      return segs[1];
    }

    // GitHub general cases
    if (host.includes("github.com") && segs.length >= 2) {
      // If URL explicitly points to a raw file on github.com like
      // /<owner>/<repo>/raw/<branch>/path/to/file -> return filename
      const rawIdx = segs.indexOf("raw");
      if (rawIdx >= 0 && segs.length > rawIdx + 1) {
        return removeExt(segs[segs.length - 1]);
      }
      return segs[1];
    }

    // Fallback: use last path segment sans extension and strip hex ref if
    // present
    if (segs.length > 0) {
      let last = removeExt(segs[segs.length - 1]);
      last = stripHexRef(last);
      return last;
    }

    // final fallback: hostname
    return host;
  } catch {
    // Best-effort fallback for non-URL inputs: use last path token and remove
    // extension
    const parts = url.split("/").filter(Boolean);
    if (parts.length === 0) return url;
    const lastRaw = parts[parts.length - 1].split("?")[0].split("#")[0];
    const withoutExt = lastRaw.includes(".")
      ? lastRaw.slice(0, lastRaw.lastIndexOf("."))
      : lastRaw;
    return withoutExt.replace(/-[0-9a-f]{7,40}$/i, "");
  }
}

Deno.test("github archive -> repo name", () => {
  const url =
    "https://github.com/Shougo/dpp-protocol-git/archive/refs/heads/main.zip";
  assertEquals(getDirectoryName(url), "dpp-protocol-git");
});

Deno.test("bitbucket get -> repo name", () => {
  const url = "https://bitbucket.org/spilt/vim-peg/get/c6be9c909538.zip";
  assertEquals(getDirectoryName(url), "vim-peg");
});

Deno.test("raw.githubusercontent -> filename without extension", () => {
  const url =
    "https://raw.githubusercontent.com/Shougo/shougo-s-github/master/vim/colors/candy.vim";
  assertEquals(getDirectoryName(url), "candy");
});

Deno.test("github blob/raw file -> filename", () => {
  const url = "https://github.com/owner/repo/raw/branch/path/to/file.txt";
  assertEquals(getDirectoryName(url), "file");
});

Deno.test("gitlab archive pattern -> repo name", () => {
  const url = "https://gitlab.com/foo/bar/-/archive/main/bar-main.zip";
  assertEquals(getDirectoryName(url), "bar");
});

Deno.test("fallback filename with hex ref stripped", () => {
  const url = "https://example.com/downloads/mylib-abcdef1234567.zip";
  assertEquals(getDirectoryName(url), "mylib");
});

Deno.test("non-url input fallback", () => {
  const input = "some/path/to/file.ext";
  assertEquals(getDirectoryName(input), "file");
});
