#!/usr/bin/env node

// Bubblewrap delegates signing to apksigner, whose failure output can echo the
// complete command line. Both password arguments are credentials, regardless
// of whether apksigner renders them quoted, unquoted, or with `=`.
const passwordArgument = /(--(?:ks|key)-pass)(\s*=\s*|\s+)(pass:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/giu;

const credentialEnvNames = [
  'PKW_STORE_KEYSTORE_PASSWORD',
  'BUBBLEWRAP_KEYSTORE_PASSWORD',
  'BUBBLEWRAP_KEY_PASSWORD',
];

export function redactBuildOutput(output, exactSecrets = []) {
  let redacted = output.replace(passwordArgument, '$1$2[REDACTED]');
  // Some failing wrappers print `env`, `NAME=value`, or the raw value without
  // apksigner's `pass:` prefix. Replace the exact secret after the structural
  // pass so every diagnostic form is covered without guessing its syntax.
  for (const secret of new Set(exactSecrets.filter((value) => value))) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

let output = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  output += chunk;
});
process.stdin.on('end', () => {
  process.stdout.write(redactBuildOutput(output, credentialEnvNames.map((name) => process.env[name] ?? '')));
});
process.stdin.on('error', () => {
  // Never include the input or error object here: either may carry buffered
  // signing-tool output. The caller treats this as a hard build failure.
  process.stderr.write('build output redactor failed\n');
  process.exitCode = 1;
});
