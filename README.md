# dpp-protocol-http

This ext implements http operations.

The downloader accepts plugin URLs in these forms:

- Archive downloads (examples):
  - GitHub archive: `https://github.com/<owner>/<repo>/archive/.../xxx.zip`
  - GitLab archive: `https://gitlab.com/<owner>/<repo>/-/archive/.../*.zip`
  - Bitbucket get: `https://bitbucket.org/<owner>/<repo>/get/<hash>.zip`
  - Releases/download assets:
    `https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>`
  - Direct archive files: `https://example.com/path/to/foo.zip` (or
    .tar.gz/.tgz/...)

- Raw single-file URLs:
  - `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/path/to/file.vim`
    NOTE: these are downloaded as a single file

Plain repository root URLs like `https://github.com/owner/repo` are
intentionally rejected — only archives or single-file URLs are supported.

## Required

NOTE: To download plugins, "curl" or "wget" is required.

### denops.vim

https://github.com/vim-denops/denops.vim

### dpp.vim

https://github.com/Shougo/dpp.vim

### System command-line tools (required/optional)

To download and extract plugins the runtime relies on common CLI tools. At
minimum one _downloader_ is required:

- Required (at least one):
  - `curl` or `wget` — used to download files from HTTP(S) URLs NOTE: If neither
    `curl` nor `wget` is available the downloader cannot work.

- Required for archive extraction (at least one set, depending on archive type):
  - For ZIP archives:
    - `unzip` OR `python3` (zipfile module) — one of these must be available to
      extract `.zip`.
  - For tar archives (`.tar`, `.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`):
    - `tar` OR `python3` (tarfile module) — one of these must be available to
      extract tar-like archives.

- Optional but recommended for robust mover/cleanup:
  - `cp` or `rsync` — used to move extracted files from a temporary directory
    into the final destination when needed (zip extraction often creates a
    top-level folder).
  - `rm` — cleanup temporary files/directories.

Summary:

- Downloader: `curl` or `wget` (required)
- Extractors:
  - zip: `unzip` or `python3`
  - tar: `tar` or `python3`
- Movers (recommended): `cp` or `rsync` (or `python3` mover)
- Cleanup: `rm`

## Configuration

```typescript
args.contextBuilder.setGlobal({
  protocols: [
    "http",
  ],
});
```
