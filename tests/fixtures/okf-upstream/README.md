# Vendored OKF upstream validator

- **Upstream:** https://github.com/open-knowledge-format/open-knowledge-format
- **Pinned commit:** `527e81aff55992be21507e97004286789126f88c`
- **File:** `skills/okf-generate/scripts/validate.py` (copied as `validate.py`)
- **License:** Apache License 2.0 (Copyright 2026 Google LLC), as stated in the script header

Do not edit `validate.py` locally except to re-vendor from the pinned SHA.
Requires Python 3 and PyYAML. CI installs with `python3 -m pip install pyyaml`. Locally (PEP 668), `okf-upstream.test.ts` creates `tests/fixtures/okf-upstream/.venv` (gitignored) and installs PyYAML there when system python cannot import `yaml`.
