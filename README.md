# @andre-barbosa/pi-commit

A read-only [pi](https://pi.dev) extension that suggests Conventional Commit messages for uncommitted changes.

**pi-commit never stages files and never creates commits.** It only inspects Git state, sends bounded change context to a model, and displays suggested text.

## Install

Install from npm:

```bash
pi install npm:@andre-barbosa/pi-commit
```

Try a local checkout without installing it:

```bash
pi -e ./src/index.ts
```

Or install the local checkout as a pi package:

```bash
pi install .
```

The package can also be placed in a global or project extension directory supported by pi.

## Commands

### One message for all changes

```text
/commit
```

### One message per folder

```text
/commit /folder1 /folder2
```

Folder arguments are relative to the Git repository root. Leading `/` is optional and denotes the repository root; it is not an absolute filesystem path. Quote folders containing spaces:

```text
/commit "/packages/web app" /packages/api
```

Overlapping folder arguments are rejected so the same change is not described twice. Folders with no changes are reported and skipped. The command does not stage or partition changes—it only returns suggested messages.

### Select a smaller model

```text
/commit-model
```

The interactive selector shows eight models at a time, fuzzy-filters as you type, and opens on the current commit model.
A model can also be selected directly:

```text
/commit-model google/gemini-2.5-flash
```

For a temporary CLI override:

```bash
pi --commit-model google/gemini-2.5-flash
```

The selection is independent from pi's conversation model: pi-commit never calls `pi.setModel()`. Interactive selections are saved in `pi-commit.json` under pi's global agent directory. Credentials remain managed by pi; configure providers through `/login` or `models.json`.

## Output

Each model call must return exactly one line in this form:

```text
feat(ui): add compact navigation controls
```

Allowed types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`. Responses are validated and retried once when malformed.

Suggestions open in an editor dialog for copying or manual adjustment. Closing the dialog has no side effect.

## What is inspected

pi-commit reads:

- NUL-delimited `git status` output
- staged and unstaged diff statistics
- staged and unstaged patches
- bounded previews of untracked text files

Binary files and symlinks are represented by metadata. Untracked files with names that appear sensitive, such as `.env`, credential, secret, PEM, or key files, are not read. Context is capped before it is sent to the model, while complete filenames and statuses are retained.

Selected model providers receive the included source diff. Review the provider's privacy policy before using the extension with sensitive repositories. Tracked sensitive files may still appear in Git patches.

## Safety boundary

Production Git execution is centralized in `ReadOnlyGit` and permits only:

- `git rev-parse`
- `git status`
- `git diff`

Commands are invoked with argument arrays, external diff/text conversion is disabled, and there is no implementation for `git add`, `git commit`, `git stash`, `git reset`, checkout, or push.

## Development

```bash
npm install
npm run check
npm test
```
