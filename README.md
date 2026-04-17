# JupyterLab Nitro AI Judge

JupyterLab extension that adds a notebook toolbar button, `Submit to Nitro AI Judge`, and guides the user through login, contest selection, task selection, CSV submission, source attachment, and feedback review.

## Features

- notebook toolbar button for direct submission flow
- login prompt backed by `nitro-ai-judge-cli`
- contest and task loading from Nitro AI Judge
- CSV file picker rooted at the current notebook directory
- source selection from either a file or the current notebook exported as Python
- automatic polling until scoring feedback is available
- results view with total score plus per-subtask score and metric values

## Requirements

- Python 3.10+
- JupyterLab 4.x
- `nitro-ai-judge-cli` available in the same Python environment as JupyterLab

## Install

```bash
python -m pip install jupyterlab-nitro-ai-judge
```

For local development in this repo:

```bash
npm install
python -m pip install -U pip build hatchling hatch-jupyter-builder jupyterlab
python -m pip install -e .
```

## Development

Build the frontend bundle:

```bash
python -m pip install -U jupyterlab
npm run build:prod
```

Build the Python package:

```bash
python -m build
```

## Usage

1. Open a notebook in JupyterLab.
2. Click `Submit to Nitro AI Judge` in the notebook toolbar.
3. Log in if prompted.
4. Select the contest and task.
5. Pick the output CSV file.
6. Choose either a source file or the current notebook as the source attachment.
7. Submit and wait for feedback.
8. Review the total score and per-subtask metrics in the Nitro panel.

## Publishing

Before publishing, replace the placeholder GitHub URLs in `package.json` and `pyproject.toml`.

PyPI release flow:

```bash
python -m pip install -U build twine
python -m build
python -m twine check dist/*
git tag v0.1.4
git push origin main --tags
```

The included GitHub workflows build on pushes and publish to PyPI on version tags.
