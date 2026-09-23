# Security

## What this tool touches

- **No network.** The router never makes a network or model call.
- **Env vars by name only.** A lane's `requiresEnv` lists variable names. The router checks whether each is set and never reads the value into any output, note, or log.
- **One write.** With `--log`, it appends one JSON line per decision to `log.path` (default `.model-caddie/decisions.jsonl` in the working directory). The path is confined to a relative, `.jsonl` path inside the working directory at both config-load time and write time (the real, resolved location is checked too, so a symlink or junction inside the project cannot redirect it), and the writer refuses to append to a file that already exists but is not itself a JSONL log, so a config cannot be used to add a line to a script or shell profile. Task text is left out of the log by default (`"taskText": "omit"`). A config can opt in to `"truncate"`, and even then task text is dropped automatically whenever the router's own sensitive-data signal fires: an email address, a phone number, a configured sensitive term, `password=`/`token:`-style assignments, or a key-shaped string such as `sk-...` or `ghp_...`.
- **Config errors never echo file content.** A config file that fails to parse as JSON reports only the character position of the failure, never the surrounding text, in case `--config` was accidentally pointed at a file holding a secret instead of a router config.

## Configs from other people

A config decides where the log is written and which words count as overrides. Read a config before you use one you did not write, the same as you would a script.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository (Security tab, "Report a vulnerability") instead of a public issue. Include a reproduction. You should get a reply within a week.
