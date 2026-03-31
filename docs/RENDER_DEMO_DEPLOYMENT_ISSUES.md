# Render Demo Deployment Issues

## Non-Blocking

- Windows `Start-Process npm` did not resolve the executable path reliably during local sanity checks. Local RC was rerun successfully with `npm.cmd`. This does not affect Render, which runs the command directly in Linux.

## External-Only

- No `git remote` is configured in the local repository, so this environment cannot push the prepared Render blueprint to a Git provider.
- No Render account/session integration is available in this environment, so a live public URL cannot be created from here.
