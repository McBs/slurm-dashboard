# Repository Instructions

## Releases

When the user asks to release the current changes, use the next semantic version, update both `package.json` and `package-lock.json`, run the relevant checks, commit the changes, and create a matching `v<version>` tag. Only push the commit and tag when the user has explicitly requested publishing or releasing.

Pushing a `v*` tag triggers `.github/workflows/ci.yaml`. After the tests pass, the workflow automatically creates the GitHub Release and uploads both the versioned VSIX and the stable `slurm-dashboard.vsix` asset. This fork uses GitHub Releases for installation and does not publish to the VS Code Marketplace.

## Remote VS Code Server Installation

Use this stable command when the user asks how to install or update the extension on a remote VS Code Server:

```bash
CODE_SERVER="$(find "$HOME/.vscode-server/" -path '*/code-server' -type f | head -n 1)" \
  && test -n "$CODE_SERVER" \
  && curl -fL https://github.com/McBs/slurm-dashboard/releases/latest/download/slurm-dashboard.vsix \
    -o "/tmp/slurm-dashboard-$USER.vsix" \
  && "$CODE_SERVER" --install-extension "/tmp/slurm-dashboard-$USER.vsix" --force
```

Tell the user to reload the remote VS Code window after installation.
