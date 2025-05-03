**3. Development Workflow & VS Code:**

- **Setup:**
  1.  Install `uv`: Follow instructions at [https://github.com/astral-sh/uv](https://github.com/astral-sh/uv)
  2.  Create a virtual environment: `uv venv` (creates `.venv`)
  3.  Activate it: `source .venv/bin/activate`
  4.  Install dependencies: `uv pip install -e .[dev]` (Installs package in editable mode + dev deps)
  5.  Copy `.env.example` to `.env` if needed for local settings.
- **Running Locally:**
  `uvicorn meridian_ml_service.main:app --reload --host 0.0.0.0 --port 8080`
- **Linting/Formatting:**
  `uv run ruff check . --fix`
  `uv run ruff format .`
- **Type Checking:**
  `uv run mypy src/`
- **VS Code:**
  1.  Install the official **Python** extension (Microsoft).
  2.  Install the **Ruff** extension (Astral Software). Configure it to use `ruff format` on save if desired.
  3.  Install the **Mypy Type Checker** extension (Microsoft).
  4.  Ensure VS Code detects and uses the `.venv` virtual environment. Your editor should now show linting/formatting/type errors inline.
