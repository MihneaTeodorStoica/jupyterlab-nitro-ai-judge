import '../style/index.css';

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  Dialog,
  ReactWidget,
  showDialog
} from '@jupyterlab/apputils';
import { PathExt, URLExt } from '@jupyterlab/coreutils';
import { NotebookPanel, INotebookTracker } from '@jupyterlab/notebook';
import { Contents, ServerConnection } from '@jupyterlab/services';
import { ToolbarButton } from '@jupyterlab/ui-components';
import { Message } from '@lumino/messaging';
import React from 'react';

type LoginStatus = {
  loggedIn: boolean;
  username: string | null;
};

type Contest = {
  org: string;
  slug: string;
  title: string;
};

type Task = {
  id: string;
  title: string;
  synopsis: string;
};

type SubmissionSubtask = {
  id: string | number;
  title: string;
  metricName: string;
  maxScore: number | string | null;
  partialScore: number | string | null;
  partialMetric: number | string | null;
  completeScore: number | string | null;
  completeMetric: number | string | null;
};

type SubmissionResult = {
  id: string;
  state: string;
  partialScore: number | string | null;
  completeScore: number | string | null;
  subtasks: SubmissionSubtask[];
};

type FilePickerValue = {
  currentPath: string;
  selectedPath: string | null;
  selectedType: Contents.ContentType | null;
};

async function requestAPI<T>(
  endPoint: string,
  init: RequestInit = {}
): Promise<T> {
  const settings = ServerConnection.makeSettings();
  const requestUrl = URLExt.join(settings.baseUrl, 'nitro-ai-judge', endPoint);

  const response = await ServerConnection.makeRequest(requestUrl, init, settings);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data.message ?? data.reason ?? response.statusText;
    throw new Error(String(message));
  }

  return data as T;
}

function notebookDirectory(panel: NotebookPanel): string {
  const dir = PathExt.dirname(panel.context.path);
  return dir === '.' ? '' : dir;
}

function notebookToPython(panel: NotebookPanel): string {
  const cells = panel.content.widgets.filter(cell => cell.model.type === 'code');

  return cells
    .map((cell, index) => {
      const source = cell.model.sharedModel.getSource().trimEnd();
      return `# %% [code cell ${index + 1}]\n${source}`;
    })
    .join('\n\n')
    .trim() + '\n';
}

class FilePickerBody extends ReactWidget {
  constructor(
    model: Contents.IModel,
    currentPath: string,
    options: {
      acceptFile?: (item: Contents.IModel) => boolean;
      emptyMessage?: string;
    } = {}
  ) {
    super();
    this._items = ((model.content as Contents.IModel[]) ?? []).filter(item => {
      if (item.type === 'directory') {
        return true;
      }
      return options.acceptFile ? options.acceptFile(item) : true;
    });
    this._currentPath = currentPath;
    this._emptyMessage = options.emptyMessage ?? 'No matching files in this folder.';
  }

  getValue(): FilePickerValue {
    return {
      currentPath: this._currentPath,
      selectedPath: this._selectedPath,
      selectedType: this._selectedType
    };
  }

  render(): React.JSX.Element {
    const entries = this._items.slice().sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return (
      <div>
        <p className="jp-NitroJudgeMuted">Current path: {this._currentPath || '/'}</p>
        <div className="jp-NitroJudgePickerList">
          {entries.length === 0 ? <p className="jp-NitroJudgeMuted">{this._emptyMessage}</p> : null}
          {entries.map(item => {
            const isSelected = item.path === this._selectedPath;
            const prefix = item.type === 'directory' ? 'Open folder' : 'Select file';
            return (
              <button
                key={item.path}
                className="jp-NitroJudgePickerItem"
                data-selected={isSelected}
                onClick={() => {
                  this._selectedPath = item.path;
                  this._selectedType = item.type;
                  this.update();
                }}
                type="button"
              >
                {prefix}: {item.name}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  private _items: Contents.IModel[];
  private _currentPath: string;
  private _emptyMessage: string;
  private _selectedPath: string | null = null;
  private _selectedType: Contents.ContentType | null = null;
}

async function pickFile(
  app: JupyterFrontEnd,
  startPath: string,
  title: string,
  options: {
    acceptFile?: (item: Contents.IModel) => boolean;
    emptyMessage?: string;
  } = {}
): Promise<string | null> {
  let currentPath = startPath;

  while (true) {
    const model = await app.serviceManager.contents.get(currentPath, { content: true });
    if (model.type !== 'directory') {
      throw new Error(`Path is not a directory: ${currentPath}`);
    }

    const body = new FilePickerBody(model, currentPath, options);
    const buttons = [
      Dialog.cancelButton(),
      Dialog.okButton({ label: 'Up' }),
      Dialog.okButton({ label: 'Open' }),
      Dialog.okButton({ label: 'Select' })
    ];
    const result = await showDialog<FilePickerValue>({ title, body, buttons });
    const value = result.value;

    if (!result.button.accept || !value) {
      return null;
    }

    if (result.button.label === 'Up') {
      currentPath = PathExt.dirname(currentPath);
      if (currentPath === '.') {
        currentPath = '';
      }
      continue;
    }

    if (result.button.label === 'Open' && value.selectedPath && value.selectedType === 'directory') {
      currentPath = value.selectedPath;
      continue;
    }

    if (result.button.label === 'Select' && value.selectedPath && value.selectedType === 'file') {
      return value.selectedPath;
    }
  }
}

class NitroJudgeBody extends ReactWidget {
  constructor(app: JupyterFrontEnd, panel: NotebookPanel) {
    super();
    this.addClass('jp-NitroJudgePanel');
    this._app = app;
    this._panel = panel;
  }

  protected onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    if (!this._initialized) {
      this._initialized = true;
      void this._initialize();
    }
  }

  render(): React.JSX.Element {
    const loadingText = this._busy ? this._busyMessage || 'Working...' : null;
    const selectedContestValue = this._selectedContest
      ? `${this._selectedContest.org}/${this._selectedContest.slug}`
      : '';

    return (
      <div>
          <p>
            Notebook: <code>{this._panel.context.path}</code>
          </p>

        {this._error ? (
          <div className="jp-NitroJudgeMessage" data-kind="error">
            {this._error}
          </div>
        ) : null}

        {loadingText ? (
          <div className="jp-NitroJudgeMessage" data-kind="info">
            {loadingText}
          </div>
        ) : null}

        <section>
          <h3>Login</h3>
          {this._status.loggedIn ? (
            <p>
              Logged in as <strong>{this._status.username}</strong>.
            </p>
          ) : (
            <div className="jp-NitroJudgeGrid">
              <label>
                Username
                <input
                  value={this._username}
                  onChange={event => {
                    this._username = event.currentTarget.value;
                    this.update();
                  }}
                  placeholder="Nitro username"
                  type="text"
                />
              </label>
              <label>
                Password
                <input
                  value={this._password}
                  onChange={event => {
                    this._password = event.currentTarget.value;
                    this.update();
                  }}
                  placeholder="Nitro password"
                  type="password"
                />
              </label>
              <div className="jp-NitroJudgeActions">
                <button disabled={this._busy} onClick={() => void this._login()} type="button">
                  Log in
                </button>
              </div>
            </div>
          )}
        </section>

        <section>
          <h3>Submission</h3>
          <div className="jp-NitroJudgeGrid">
            <label>
              Contest
              <select
                disabled={!this._status.loggedIn || this._busy}
                onChange={event => void this._selectContest(event.currentTarget.value)}
                value={selectedContestValue}
              >
                <option value="">Select a contest</option>
                {this._contests.map(contest => {
                  const value = `${contest.org}/${contest.slug}`;
                  return (
                    <option key={value} value={value}>
                      {contest.title || value}
                    </option>
                  );
                })}
              </select>
            </label>

            <label>
              Task
              <select
                disabled={!this._selectedContest || this._busy}
                onChange={event => {
                  const task = this._tasks.find(item => item.id === event.currentTarget.value) ?? null;
                  this._selectedTask = task;
                  this.update();
                }}
                value={this._selectedTask?.id ?? ''}
              >
                <option value="">Select a task</option>
                {this._tasks.map(task => (
                  <option key={task.id} value={task.id}>
                    {task.id}: {task.title}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Output CSV
              <div className="jp-NitroJudgeRow">
                <input
                  onChange={event => {
                    this._outputPath = event.currentTarget.value;
                    this.update();
                  }}
                  placeholder="path/to/output.csv"
                  type="text"
                    value={this._outputPath}
                />
                <button disabled={this._busy} onClick={() => void this._pickOutput()} type="button">
                  Browse
                </button>
              </div>
              <p className="jp-NitroJudgeMuted">Choose a `.csv` file from the notebook folder tree.</p>
            </label>

            <div>
              <label>Source code</label>
              <div className="jp-NitroJudgeRadioGroup">
                <label>
                  <input
                    checked={this._sourceMode === 'notebook'}
                    name="nitro-source-mode"
                    onChange={() => {
                      this._sourceMode = 'notebook';
                      this.update();
                    }}
                    type="radio"
                  />
                  Current notebook as Python
                </label>
                <label>
                  <input
                    checked={this._sourceMode === 'file'}
                    name="nitro-source-mode"
                    onChange={() => {
                      this._sourceMode = 'file';
                      this.update();
                    }}
                    type="radio"
                  />
                  Source file
                </label>
              </div>
            </div>

            {this._sourceMode === 'file' ? (
              <label>
                Source file
                <div className="jp-NitroJudgeRow">
                  <input
                    onChange={event => {
                      this._sourcePath = event.currentTarget.value;
                      this.update();
                    }}
                    placeholder="path/to/solution.py"
                    type="text"
                    value={this._sourcePath}
                  />
                  <button disabled={this._busy} onClick={() => void this._pickSource()} type="button">
                    Browse
                  </button>
                </div>
              </label>
            ) : (
              <p className="jp-NitroJudgeMuted">
                The current notebook will be exported from code cells into a temporary Python file.
              </p>
            )}

            <label>
              Note
              <textarea
                onChange={event => {
                  this._note = event.currentTarget.value;
                  this.update();
                }}
                placeholder="Optional note"
                rows={3}
                value={this._note}
              />
            </label>
          </div>

          <div className="jp-NitroJudgeActions">
            <button disabled={this._busy || !this._canSubmit()} onClick={() => void this._submit()} type="button">
              Submit and Wait for Feedback
            </button>
            <button disabled={this._busy || !this._status.loggedIn} onClick={() => void this._loadContests()} type="button">
              Refresh contests
            </button>
          </div>
        </section>

        {this._result ? (
          <section>
            <h3>Feedback</h3>
            <div className="jp-NitroJudgeSummary">
              <div className="jp-NitroJudgeStat">
                Submission
                <strong>{this._result.id}</strong>
              </div>
              <div className="jp-NitroJudgeStat">
                State
                <strong>{this._result.state}</strong>
              </div>
              <div className="jp-NitroJudgeStat">
                Partial total
                <strong>{this._displayValue(this._result.partialScore)}</strong>
              </div>
              <div className="jp-NitroJudgeStat">
                Complete total
                <strong>{this._displayValue(this._result.completeScore)}</strong>
              </div>
            </div>

            <h3>Subtasks</h3>
            <table className="jp-NitroJudgeTable">
              <thead>
                <tr>
                  <th>Subtask</th>
                  <th>Max</th>
                  <th>Partial score</th>
                  <th>Partial metric</th>
                  <th>Complete score</th>
                  <th>Complete metric</th>
                </tr>
              </thead>
              <tbody>
                {this._result.subtasks.map(subtask => (
                  <tr key={String(subtask.id)}>
                    <td>
                      <strong>{subtask.title}</strong>
                      <div className="jp-NitroJudgeMuted">#{subtask.id}</div>
                    </td>
                    <td>{this._displayValue(subtask.maxScore)}</td>
                    <td>{this._displayValue(subtask.partialScore)}</td>
                    <td>
                      {subtask.metricName}: {this._displayValue(subtask.partialMetric)}
                    </td>
                    <td>{this._displayValue(subtask.completeScore)}</td>
                    <td>
                      {subtask.metricName}: {this._displayValue(subtask.completeMetric)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </div>
    );
  }

  private _canSubmit(): boolean {
    if (!this._status.loggedIn || !this._selectedContest || !this._selectedTask || !this._outputPath) {
      return false;
    }
    if (!this._outputPath.toLowerCase().endsWith('.csv')) {
      return false;
    }
    if (this._sourceMode === 'file' && !this._sourcePath) {
      return false;
    }
    return true;
  }

  private _displayValue(value: string | number | null): string {
    return value === null || value === undefined || value === '' ? '-' : String(value);
  }

  private async _initialize(): Promise<void> {
    await this._setBusy('Checking Nitro AI Judge login...');
    try {
      this._status = await requestAPI<LoginStatus>('status');
      if (this._status.loggedIn) {
        await this._loadContests();
      }
    } catch (error) {
      this._error = this._asMessage(error);
    } finally {
      this._clearBusy();
    }
  }

  private async _login(): Promise<void> {
    await this._setBusy('Logging in to Nitro AI Judge...');
    this._error = null;

    try {
      this._status = await requestAPI<LoginStatus>('login', {
        body: JSON.stringify({ username: this._username, password: this._password }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      });
      this._password = '';
      await this._loadContests();
    } catch (error) {
      this._error = this._asMessage(error);
    } finally {
      this._clearBusy();
    }
  }

  private async _loadContests(): Promise<void> {
    await this._setBusy('Loading contests...');
    this._error = null;

    try {
      const response = await requestAPI<{ items: Contest[] }>('contests');
      this._contests = response.items;
      if (this._selectedContest) {
        const refreshed = this._contests.find(
          item => item.org === this._selectedContest?.org && item.slug === this._selectedContest?.slug
        );
        this._selectedContest = refreshed ?? null;
        if (this._selectedContest) {
          await this._selectContest(`${this._selectedContest.org}/${this._selectedContest.slug}`);
        }
      }
    } catch (error) {
      this._error = this._asMessage(error);
    } finally {
      this._clearBusy();
    }
  }

  private async _selectContest(value: string): Promise<void> {
    this._selectedTask = null;
    this._tasks = [];

    if (!value) {
      this._selectedContest = null;
      this.update();
      return;
    }

    const selected = this._contests.find(item => `${item.org}/${item.slug}` === value) ?? null;
    this._selectedContest = selected;

    if (!selected) {
      this.update();
      return;
    }

    await this._setBusy('Loading tasks...');
    this._error = null;
    this.update();

    try {
      const response = await requestAPI<{ items: Task[] }>(
        `tasks?org=${encodeURIComponent(selected.org)}&comp=${encodeURIComponent(selected.slug)}`
      );
      this._tasks = response.items;
    } catch (error) {
      this._error = this._asMessage(error);
    } finally {
      this._clearBusy();
    }
  }

  private async _pickOutput(): Promise<void> {
    try {
      const selected = await pickFile(this._app, notebookDirectory(this._panel), 'Pick output CSV', {
        acceptFile: item => item.name.toLowerCase().endsWith('.csv'),
        emptyMessage: 'No CSV files in this folder. You can still open another folder or go up.'
      });
      if (selected) {
        this._outputPath = selected;
        this.update();
      }
    } catch (error) {
      this._error = this._asMessage(error);
      this.update();
    }
  }

  private async _pickSource(): Promise<void> {
    try {
      const selected = await pickFile(this._app, notebookDirectory(this._panel), 'Pick source file');
      if (selected) {
        this._sourcePath = selected;
        this.update();
      }
    } catch (error) {
      this._error = this._asMessage(error);
      this.update();
    }
  }

  private async _submit(): Promise<void> {
    if (!this._selectedContest || !this._selectedTask) {
      return;
    }

    await this._setBusy('Submitting to Nitro AI Judge and waiting for feedback...');
    this._error = null;
    this._result = null;

    try {
      const payload: Record<string, unknown> = {
        org: this._selectedContest.org,
        comp: this._selectedContest.slug,
        taskId: this._selectedTask.id,
        outputPath: this._outputPath,
        note: this._note
      };

      if (this._sourceMode === 'file') {
        payload.sourcePath = this._sourcePath;
      } else {
        payload.sourceContent = notebookToPython(this._panel);
        payload.sourceFilename = PathExt.basename(this._panel.context.path).replace(/\.ipynb$/i, '.py');
      }

      const response = await requestAPI<{ submission: SubmissionResult }>('submit', {
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      });
      this._result = response.submission;
    } catch (error) {
      this._error = this._asMessage(error);
    } finally {
      this._clearBusy();
    }
  }

  private _asMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return String(error);
  }

  private async _setBusy(message: string): Promise<void> {
    this._busy = true;
    this._busyMessage = message;
    this.update();
    await Promise.resolve();
  }

  private _clearBusy(): void {
    this._busy = false;
    this._busyMessage = null;
    this.update();
  }

  private _app: JupyterFrontEnd;
  private _panel: NotebookPanel;
  private _initialized = false;
  private _status: LoginStatus = { loggedIn: false, username: null };
  private _username = '';
  private _password = '';
  private _contests: Contest[] = [];
  private _tasks: Task[] = [];
  private _selectedContest: Contest | null = null;
  private _selectedTask: Task | null = null;
  private _outputPath = '';
  private _sourceMode: 'notebook' | 'file' = 'notebook';
  private _sourcePath = '';
  private _note = '';
  private _busy = false;
  private _busyMessage: string | null = null;
  private _error: string | null = null;
  private _result: SubmissionResult | null = null;
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-nitro-ai-judge:plugin',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    tracker.widgetAdded.connect((_sender, notebook) => {
      notebook.toolbar.insertAfter(
        'cellType',
        'nitro-ai-judge-submit',
        new ToolbarButton({
          label: 'Submit to Nitro AI Judge',
          onClick: () => {
            void showDialog({
              title: `Nitro AI Judge: ${PathExt.basename(notebook.context.path)}`,
              body: new NitroJudgeBody(app, notebook),
              buttons: [Dialog.cancelButton({ label: 'Close' })]
            });
          },
          tooltip: 'Open Nitro AI Judge submission popup'
        })
      );
    });
  }
};

export default plugin;
