# dpp-protocol-http

This ext implements http operations.

It supports zip file extract.

## Required

NOTE: To download plugins, "curl" or "wget" is required.

### denops.vim

https://github.com/vim-denops/denops.vim

### dpp.vim

https://github.com/Shougo/dpp.vim

## Configuration

```typescript
  args.contextBuilder.setGlobal({
    protocols: [
      "http",
    ],
  });
```
