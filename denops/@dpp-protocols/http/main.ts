import type { Plugin, ProtocolOptions } from "@shougo/dpp-vim/types";
import { BaseProtocol, type Command } from "@shougo/dpp-vim/protocol";
import { assertEquals } from "@std/assert/equals";

import type { Denops } from "@denops/std";
import * as vars from "@denops/std/variable";
import * as fn from "@denops/std/function";
import { basename } from "@std/path/basename";

export type Params = Record<string, never>;

export type Attrs = Record<string, never>;

// helper: typical archive/file extensions
const archiveExts = [
  ".bz2",
  ".gz",
  ".tar",
  ".tar.bz2",
  ".tar.gz",
  ".tar.xz",
  ".tgz",
  ".zip",
];

export class Protocol extends BaseProtocol<Params> {
  override async detect(args: {
    denops: Denops;
    plugin: Plugin;
    protocolOptions: ProtocolOptions;
    protocolParams: Params;
  }): Promise<Partial<Plugin> | undefined> {
    const normalized = normalizeHttpUrl(args.plugin.repo);
    if (!normalized) {
      // Not a valid http(s) URL we can handle
      return;
    }

    const url = normalized;
    const dirname = getDirectoryName(url);

    return {
      path: `${await vars.g.get(
        args.denops,
        "dpp#_base_path",
      )}/repos/${dirname}`,
      name: basename(dirname),
      url,
    };
  }

  override async getSyncCommands(args: {
    denops: Denops;
    plugin: Plugin;
    protocolOptions: ProtocolOptions;
    protocolParams: Params;
  }): Promise<Command[]> {
    const repo = args.plugin.repo;
    const dest = args.plugin.path;
    if (!repo || !dest) return [];

    // Check URL
    let url: string;
    try {
      const u = new URL(repo.trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") return [];
      u.username = "";
      u.password = "";
      url = u.toString();
    } catch {
      return [];
    }

    const commands: Command[] = [];
    const isArchive = looksLikeArchiveUrl(url);
    const pathname = new URL(url).pathname;
    const kind = archiveKindByExts(pathname);

    if (isArchive) {
      commands.push({ command: "mkdir", args: ["-p", dest] });
    } else {
      commands.push({ command: "mkdir", args: ["-p", requireDirname(dest)] });
    }

    const executable = async (cmd: string) => {
      try {
        const r = await fn.executable(args.denops, cmd);
        return r === 1;
      } catch {
        return false;
      }
    };

    const hasCurl = await executable("curl");
    const hasWget = await executable("wget");

    if (!hasCurl && !hasWget) {
      return [];
    }

    if (isArchive) {
      const tmpfile = makeTmpFilePath("plugin");
      const tmpdir = makeTmpDirPath("plugindir");

      if (hasCurl) {
        commands.push({
          command: "curl",
          args: ["-L", "--fail", "-sSf", "-o", tmpfile, url],
        });
      } else if (hasWget) {
        commands.push({ command: "wget", args: ["-q", "-O", tmpfile, url] });
      }

      const hasUnzip = await executable("unzip");
      const hasTar = await executable("tar");
      const hasPython3 = await executable("python3");
      const hasRm = await executable("rm");

      if (kind === "zip") {
        // Extract into tmpdir (prefer unzip, fallback python)
        if (!hasUnzip && !hasPython3) return [];

        if (hasUnzip) {
          commands.push({
            command: "unzip",
            args: ["-o", tmpfile, "-d", tmpdir],
          });
        } else if (hasPython3) {
          commands.push({
            command: "python3",
            args: ["-m", "zipfile", "-e", tmpfile, tmpdir],
          });
        }

        // Use a Python mover that:
        //  - if tmpdir contains exactly one top-level directory, moves its
        //    children into dest
        //  - otherwise moves all top-level entries into dest
        // Prefer python mover because it handles the "single top-level dir"
        // case robustly.
        if (hasPython3) {
          const mover = [
            "-c",
            [
              "import os,sys,shutil",
              "src=sys.argv[1]",
              "dst=sys.argv[2]",
              "os.makedirs(dst, exist_ok=True)",
              "entries=[e for e in os.listdir(src) if e not in ('.','..')]",
              "if len(entries)==1 and os.path.isdir(os.path.join(src, entries[0])):",
              "  inner=os.path.join(src, entries[0])",
              "  for name in os.listdir(inner):",
              "    shutil.move(os.path.join(inner,name), dst)",
              "else:",
              "  for name in os.listdir(src):",
              "    shutil.move(os.path.join(src,name), dst)",
            ].join("\n"),
            tmpdir,
            dest,
          ];
          commands.push({ command: "python3", args: mover });
        } else {
          // Fallback mover using cp/rsync if python3 not available
          const hasCp = await executable("cp");
          const hasRsync = await executable("rsync");
          if (hasCp) {
            commands.push({
              command: "cp",
              args: ["-a", `${tmpdir}/.`, dest],
            });
          } else if (hasRsync) {
            commands.push({
              command: "rsync",
              args: ["-a", `${tmpdir}/`, dest],
            });
          } else {
            return []; // No way to move contents cleanly
          }
        }
      } else {
        // tar-like
        if (!hasTar && !hasPython3) return [];

        if (hasTar) {
          // tar with --strip-components=1 usually removes top-level folder
          commands.push({
            command: "tar",
            args: ["-xf", tmpfile, "-C", dest, "--strip-components=1"],
          });
        } else if (hasPython3) {
          // Python fallback - extract into tmpdir then move like zip case to
          // handle top-level dir
          commands.push({
            command: "python3",
            args: [
              "-c",
              "import tarfile,sys,os,shutil\nf=tarfile.open(sys.argv[1]); f.extractall(sys.argv[2])",
              tmpfile,
              tmpdir,
            ],
          });

          // mover same as zip case
          const mover = [
            "-c",
            [
              "import os,sys,shutil",
              "src=sys.argv[1]",
              "dst=sys.argv[2]",
              "os.makedirs(dst, exist_ok=True)",
              "entries=[e for e in os.listdir(src) if e not in ('.','..')]",
              "if len(entries)==1 and os.path.isdir(os.path.join(src, entries[0])):",
              "  inner=os.path.join(src, entries[0])",
              "  for name in os.listdir(inner):",
              "    shutil.move(os.path.join(inner,name), dst)",
              "else:",
              "  for name in os.listdir(src):",
              "    shutil.move(os.path.join(src,name), dst)",
            ].join(";"),
            tmpdir,
            dest,
          ];
          commands.push({ command: "python3", args: mover });
        }
      }

      // Cleanup tmpfile and tmpdir
      if (hasRm) {
        commands.push({ command: "rm", args: ["-f", tmpfile] });
        commands.push({ command: "rm", args: ["-rf", tmpdir] });
      }

      return commands;
    } else {
      if (hasCurl) {
        commands.push({
          command: "curl",
          args: ["-L", "--fail", "-sSf", "-o", dest, url],
        });
      } else if (hasWget) {
        commands.push({ command: "wget", args: ["-q", "-O", dest, url] });
      }
      return commands;
    }
  }

  override params(): Params {
    return {};
  }
}

function normalizeHttpUrl(repo?: string): string | undefined {
  if (!repo) return undefined;
  let raw = repo.trim();

  // Allow "git+https://" prefix and normalize it away.
  if (raw.toLowerCase().startsWith("git+")) {
    raw = raw.slice(4);
  }

  // Quick reject for obviously non-URLs
  if (!/^https?:\/\//i.test(raw)) return undefined;

  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;

    // Remove credentials for safety
    u.username = "";
    u.password = "";

    const host = u.hostname.toLowerCase();
    const pathname = u.pathname || "";
    const segs = pathname.split("/").filter(Boolean);

    const endsWithArchiveExt = archiveExts.some((e) =>
      pathname.toLowerCase().endsWith(e)
    );

    // Accept criteria (only these are allowed):
    // 1) raw.githubusercontent.com direct file URLs (single file)
    if (host === "raw.githubusercontent.com" && segs.length > 0) {
      return u.toString();
    }

    // 2) URLs that end with archive extensions (.zip, .tar.gz, etc.)
    if (endsWithArchiveExt) {
      return u.toString();
    }

    // 3) GitHub releases assets:
    //    - /<owner>/<repo>/releases/download/<tag>/<asset>
    if (
      host.includes("github.com") && segs.includes("releases") &&
      segs.includes("download")
    ) {
      return u.toString();
    }

    // 4) Archive patterns:
    //    - GitHub: /<owner>/<repo>/archive/...
    //    - GitLab: /<owner>/<repo>/-/archive/...
    if (
      segs.includes("archive") ||
      (segs.includes("-") && segs.includes("archive"))
    ) {
      return u.toString();
    }

    // 5) Bitbucket "get" pattern:
    //    - /<owner>/<repo>/get/...
    if (host.includes("bitbucket.org") && segs.includes("get")) {
      return u.toString();
    }

    // 6) explicit raw path on github.com:
    //    - /<owner>/<repo>/raw/<branch>/path/to/file
    if (host.includes("github.com") && segs.includes("raw")) {
      return u.toString();
    }

    // Otherwise reject
    // (this excludes plain repo roots like https://github.com/owner/repo)
    return undefined;
  } catch {
    return undefined;
  }
}

function removeExt(name: string): string {
  const lower = name.toLowerCase();
  for (const e of archiveExts) {
    if (lower.endsWith(e)) return name.slice(0, -e.length);
  }
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

function stripHexRef(name: string): string {
  return name.replace(/-[0-9a-f]{7,40}$/i, "");
}

function stripGitSuffix(name: string): string {
  return name.replace(/\.git$/i, "");
}

/**
 * Convert a plugin URL to a directory identifier.
 *
 * Examples:
 * - https://github.com/folke/lazy.nvim/archive/refs/heads/main.zip
     -> "github.com/folke/lazy.nvim"
 * - https://bitbucket.org/spilt/vim-peg/get/c6be9c909538.zip
     -> "bitbucket.org/spilt/vim-peg"
 * - https://raw.githubusercontent.com/Shougo/.../candy.vim -> "candy"
 * - https://example.com/downloads/mylib-abcdef1234567.zip -> "mylib"
 */
function getDirectoryName(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const segs = u.pathname.split("/").filter(Boolean);

    // raw.githubusercontent.com -> use filename (without extension)
    if (host === "raw.githubusercontent.com" && segs.length > 0) {
      return removeExt(segs[segs.length - 1]);
    }

    // If we have at least owner/repo segments, prefer returning
    // host/owner/repo for repository-like or archive-like URLs so directory
    // becomes: "<host>/<owner>/<repo>"
    if (segs.length >= 2) {
      const owner = segs[0];
      let repo = segs[1];
      // strip possible ".git" on repo segment
      repo = stripGitSuffix(repo);

      // Cases that should map to host/owner/repo:
      // - archive/download/get/release patterns
      // - plain repo root (https://github.com/owner/repo)
      // - general repo URLs on known hosts (github/gitlab/bitbucket)
      const segSet = new Set(segs);
      const isArchivePattern = segSet.has("archive") ||
        (segSet.has("releases") && segSet.has("download")) || segSet.has("get");
      const knownHost = host.includes("github.com") ||
        host.includes("gitlab.com") || host.includes("bitbucket.org") ||
        host.includes("git") || host.includes("githubusercontent.com");

      if (isArchivePattern || knownHost) {
        return `${host}/${owner}/${repo}`;
      }
    }

    // Fallbacks:
    // - If pathname ends with a filename, return filename without extension
    //   (strip hex ref)
    if (segs.length > 0) {
      const last = removeExt(segs[segs.length - 1]);
      return stripHexRef(last);
    }

    // final fallback: hostname
    return u.hostname.toLowerCase();
  } catch {
    // Non-URL input: return last path token without extension and hex ref
    const parts = url.split("/").filter(Boolean);
    if (parts.length === 0) return url;
    const lastRaw = parts[parts.length - 1].split("?")[0].split("#")[0];
    const withoutExt = lastRaw.includes(".")
      ? lastRaw.slice(0, lastRaw.lastIndexOf("."))
      : lastRaw;
    return withoutExt.replace(/-[0-9a-f]{7,40}$/i, "");
  }
}

// sort extensions by length desc to match `.tar.gz` before `.gz`
const sortedArchiveExts = [...archiveExts].sort((a, b) => b.length - a.length);

function isArchiveByExtFromPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return sortedArchiveExts.some((e) => lower.endsWith(e));
}

/**
 * Determine archive kind using archiveExts.
 * Returns:
 *  - "zip" for .zip
 *  - "tar" for tar-like extensions: .tar, .tar.gz, .tgz, .tar.bz2, .tar.xz
 *  - undefined for single-stream compressions like .gz/.bz2 (treated as file by default)
 */
function archiveKindByExts(pathname: string): "zip" | "tar" | undefined {
  const lower = pathname.toLowerCase();
  for (const ext of sortedArchiveExts) {
    if (lower.endsWith(ext)) {
      if (ext === ".zip") return "zip";
      if (
        ext === ".tar" ||
        ext === ".tar.gz" ||
        ext === ".tgz" ||
        ext === ".tar.bz2" ||
        ext === ".tar.xz"
      ) {
        return "tar";
      }
      return undefined; // .gz/.bz2 etc.
    }
  }
  return undefined;
}

/**
 * Heuristic to recognize download/archive-y URLs beyond just extension.
 */
function looksLikeArchiveUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const pathname = u.pathname || "";
    // explicit archive extension
    if (isArchiveByExtFromPath(pathname)) return true;

    const segs = pathname.split("/").filter(Boolean);
    // common archive/download patterns
    if (segs.includes("archive")) return true;
    if (segs.includes("releases") && segs.includes("download")) return true;
    if (segs.includes("get")) return true;

    // raw.githubusercontent typically single-file; treat as archive only if extension suggests so
    if (u.hostname.toLowerCase() === "raw.githubusercontent.com") {
      return isArchiveByExtFromPath(pathname);
    }

    return false;
  } catch {
    return false;
  }
}

function makeTmpFilePath(prefix = "plugin"): string {
  // This creates an actual temporary file and returns its path.
  try {
    const tmpDir = Deno.env.get("TMPDIR") ??
      Deno.env.get("TMP") ??
      Deno.env.get("TEMP") ??
      "/tmp";

    // Deno.makeTempFileSync will create and return a unique temp file path.
    // Provide a prefix so files look like "plugin.<random>"
    return Deno.makeTempFileSync({ dir: tmpDir, prefix: `${prefix}.` });
  } catch {
    // Fallback: deterministic non-colliding name if temp APIs are unavailable.
    const tmpDir = "/tmp";
    const rand = Math.floor(Math.random() * 0xffffffff).toString(36);
    const ts = Date.now();
    return `${tmpDir}/${prefix}.${ts}.${rand}`;
  }
}

function makeTmpDirPath(prefix = "plugindir"): string {
  try {
    const tmpDir = Deno.env.get("TMPDIR") ?? Deno.env.get("TMP") ??
      Deno.env.get("TEMP") ?? "/tmp";
    return Deno.makeTempDirSync({ dir: tmpDir, prefix: `${prefix}.` });
  } catch {
    const rand = Math.floor(Math.random() * 0xffffffff).toString(36);
    const ts = Date.now();
    const path = `/tmp/${prefix}.${ts}.${rand}`;
    // attempt to create it at runtime via mkdir command later (we still return path)
    return path;
  }
}

/**
 * Minimal dirname implementation.
 */
function requireDirname(path: string): string {
  if (!path) return ".";
  const p = path.replace(/[\/\\]+$/, "");
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx === -1) return ".";
  const dir = p.slice(0, idx) || "/";
  return dir;
}

Deno.test("github archive -> host/owner/repo", () => {
  const url =
    "https://github.com/Shougo/dpp-protocol-git/archive/refs/heads/main.zip";
  assertEquals(getDirectoryName(url), "github.com/Shougo/dpp-protocol-git");
});

Deno.test("bitbucket get -> host/owner/repo", () => {
  const url = "https://bitbucket.org/spilt/vim-peg/get/c6be9c909538.zip";
  assertEquals(getDirectoryName(url), "bitbucket.org/spilt/vim-peg");
});

Deno.test("raw.githubusercontent -> filename without extension", () => {
  const url =
    "https://raw.githubusercontent.com/Shougo/shougo-s-github/master/vim/colors/candy.vim";
  assertEquals(getDirectoryName(url), "candy");
});

Deno.test("github raw/blob path -> host/owner/repo", () => {
  const url = "https://github.com/owner/repo/raw/branch/path/to/file.txt";
  // getDirectoryName now returns host/owner/repo for known hosts
  assertEquals(getDirectoryName(url), "github.com/owner/repo");
});

Deno.test("gitlab archive pattern -> host/owner/repo", () => {
  const url = "https://gitlab.com/foo/bar/-/archive/main/bar-main.zip";
  assertEquals(getDirectoryName(url), "gitlab.com/foo/bar");
});

Deno.test("fallback filename with hex ref stripped", () => {
  const url = "https://example.com/downloads/mylib-abcdef1234567.zip";
  assertEquals(getDirectoryName(url), "mylib");
});

Deno.test("fallback plain zip file", () => {
  const url = "https://example.com/downloads/foo.zip";
  assertEquals(getDirectoryName(url), "foo");
});

Deno.test("non-url input fallback", () => {
  const input = "some/path/to/file.ext";
  assertEquals(getDirectoryName(input), "file");
});

Deno.test("rejects plain repo root (no archive/file)", () => {
  const inUrl = "https://github.com/owner/repo";
  assertEquals(normalizeHttpUrl(inUrl), undefined);
});

Deno.test("valid http url with archive extension", () => {
  const inUrl = "http://example.com/path/to/file.zip";
  assertEquals(normalizeHttpUrl(inUrl), "http://example.com/path/to/file.zip");
});

Deno.test("git+https prefix is normalized for archive/file URL", () => {
  const inUrl =
    "git+https://github.com/owner/repo/releases/download/v1.0.0/asset.tar.gz";
  assertEquals(
    normalizeHttpUrl(inUrl),
    "https://github.com/owner/repo/releases/download/v1.0.0/asset.tar.gz",
  );
});

Deno.test("rejects ssh-style repo", () => {
  const inUrl = "git@github.com:owner/repo.git";
  assertEquals(normalizeHttpUrl(inUrl), undefined);
});

Deno.test("rejects non-http protocol", () => {
  const inUrl = "ftp://example.com/repo.zip";
  assertEquals(normalizeHttpUrl(inUrl), undefined);
});

Deno.test("rejects plain owner/repo shorthand", () => {
  const inUrl = "owner/repo";
  assertEquals(normalizeHttpUrl(inUrl), undefined);
});

Deno.test("removes credentials from url", () => {
  const inUrl = "https://user:pass@example.com/path/to/res.zip";
  assertEquals(normalizeHttpUrl(inUrl), "https://example.com/path/to/res.zip");
});

Deno.test("case-insensitive scheme and host normalization", () => {
  const inUrl = "HTTPs://Example.COM/a/archive/asset.ZIP";
  assertEquals(
    normalizeHttpUrl(inUrl),
    "https://example.com/a/archive/asset.ZIP",
  );
});

Deno.test("accepts raw.githubusercontent file URL", () => {
  const inUrl =
    "https://raw.githubusercontent.com/Shougo/repo/master/vim/colors/candy.vim";
  assertEquals(
    normalizeHttpUrl(inUrl),
    "https://raw.githubusercontent.com/Shougo/repo/master/vim/colors/candy.vim",
  );
});

Deno.test("accepts github releases asset", () => {
  const inUrl =
    "https://github.com/owner/repo/releases/download/v1.0.0/asset.tar.gz";
  assertEquals(
    normalizeHttpUrl(inUrl),
    "https://github.com/owner/repo/releases/download/v1.0.0/asset.tar.gz",
  );
});

Deno.test("accepts gitlab archive pattern", () => {
  const inUrl = "https://gitlab.com/foo/bar/-/archive/main/bar-main.zip";
  assertEquals(
    normalizeHttpUrl(inUrl),
    "https://gitlab.com/foo/bar/-/archive/main/bar-main.zip",
  );
});

Deno.test("accepts bitbucket get pattern", () => {
  const inUrl = "https://bitbucket.org/spilt/vim-peg/get/c6be9c909538.zip";
  assertEquals(
    normalizeHttpUrl(inUrl),
    "https://bitbucket.org/spilt/vim-peg/get/c6be9c909538.zip",
  );
});

Deno.test("accepts plain zip file", () => {
  const url = "https://example.com/downloads/foo.zip";
  assertEquals(
    normalizeHttpUrl(url),
    "https://example.com/downloads/foo.zip",
  );
});
