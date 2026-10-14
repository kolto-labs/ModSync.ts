# Native writer ownership prerequisite

Build this production addon with a trusted C++ compiler and official Node SDK headers:

```sh
NODE_API_INCLUDE_DIR=/path/to/node/include/node node packages/core/native/build.mjs
```

The internal module locks ordinary file descriptors without truncating or unlinking files. Unix uses `flock(LOCK_EX | LOCK_NB)`. Windows source uses `LockFileEx` with zero offset and both length words `0xffffffff`, matching Rust `fs2` 0.4.3. Release refuses descriptors this addon did not acquire or whose identity changed.

`fs/writerOwnership.ts` holds private file handles, verifies stable root and lock identities, reserves canonical lock paths within the process, and acquires both mod and game root locks in UTF-8 path order. This first implementation requires existing lock files; absent locks fail closed. It is not connected to checkpoint writers or physical installation.

Linux production compilation and refusal against the real live authoring session lock are verified. macOS and Windows compilation/runtime are unproven. The TypeScript safe-open wrapper explicitly refuses Windows until a native reparse-safe file opener exists. No platform compatibility is inferred from the conditional source alone.

Physical installation stays disabled. Durable recovery acknowledgement, external-process quiescence, root-bound pending state, directory rollback, new lock publication, and integration across every writer still require implementation.

Primary contracts: [Node-API](https://nodejs.org/api/n-api.html), [LockFileEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex), and the pinned Rust `fs2` 0.4.3 source.
