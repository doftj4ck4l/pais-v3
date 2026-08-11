/**
 * A stand-in for a stdio MCP server that dies on startup, used by
 * `client.test.ts` to observe the working directory the child was given.
 *
 * It reports on stderr and exits non-zero, which is the same shape as the real
 * failure being guarded against: a launcher that never speaks MCP, whose only
 * account of itself is what it wrote on the way down.
 */
process.stderr.write(`cwd=${process.cwd()}\n`);
process.exit(1);
