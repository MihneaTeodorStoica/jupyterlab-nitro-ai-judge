import '../style/index.css';

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  MainAreaWidget,
  ReactWidget
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
  competitionStart: number | null;
  hasStarted: boolean;
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

type FilePickerOptions = {
  acceptFile?: (item: Contents.IModel) => boolean;
  emptyMessage?: string;
};

type PickerEntry = {
  name: string;
  path: string;
  type: Contents.ContentType;
};

type PickerState = {
  currentPath: string;
  emptyMessage: string;
  entries: PickerEntry[];
  error: string | null;
  loading: boolean;
  selectedPath: string | null;
  selectedType: Contents.ContentType | null;
  title: string;
  acceptFile?: (item: Contents.IModel) => boolean;
};

let contestCache: Contest[] | null = null;

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

function formatContestLabel(contest: Contest): string {
  const value = contest.title || `${contest.org}/${contest.slug}`;
  return contest.hasStarted ? value : `${value} (not started yet)`;
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
    const pickerState = this._pickerState;

    return (
      <div className="jp-NitroJudgeRoot">
        <p className="jp-NitroJudgeNotebookPath">
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
          <div className="jp-NitroJudgeSectionHeader">
            <h3>Login</h3>
            <p className="jp-NitroJudgeMuted">Sign in to load your contests and tasks.</p>
          </div>
          {this._status.loggedIn ? (
            <p className="jp-NitroJudgeStatusLine">
              Logged in as <strong>{this._status.username}</strong>.
            </p>
          ) : (
            <div className="jp-NitroJudgeGrid">
              <label className="jp-NitroJudgeFieldLabel">
                <span className="jp-NitroJudgeFieldTitle">Username</span>
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
              <label className="jp-NitroJudgeFieldLabel">
                <span className="jp-NitroJudgeFieldTitle">Password</span>
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
          <div className="jp-NitroJudgeSectionHeader">
            <h3>Submission</h3>
            <p className="jp-NitroJudgeMuted">Choose the task, output file, and source to submit.</p>
          </div>
          <div className="jp-NitroJudgeGrid">
            <label className="jp-NitroJudgeFieldLabel">
              <span className="jp-NitroJudgeFieldTitle">Contest</span>
              <select
                disabled={!this._status.loggedIn || this._busy}
                onChange={event => void this._selectContest(event.currentTarget.value)}
                value={selectedContestValue}
              >
                <option value="">Select a contest</option>
                {this._contests.map(contest => {
                  const value = `${contest.org}/${contest.slug}`;
                  return (
                    <option disabled={!contest.hasStarted} key={value} value={value}>
                      {formatContestLabel(contest)}
                    </option>
                  );
                })}
              </select>
              <p className="jp-NitroJudgeMuted">Upcoming contests are shown but unavailable until they start.</p>
            </label>

            <label className="jp-NitroJudgeFieldLabel">
              <span className="jp-NitroJudgeFieldTitle">Task</span>
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

            <label className="jp-NitroJudgeFieldLabel">
              <span className="jp-NitroJudgeFieldTitle">Output CSV</span>
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

            <fieldset className="jp-NitroJudgeSourceGroup">
              <legend className="jp-NitroJudgeFieldTitle">Source code</legend>
              <div className="jp-NitroJudgeRadioGroup" role="radiogroup" aria-label="Source code mode">
                <label className="jp-NitroJudgeSourceOption" data-selected={this._sourceMode === 'notebook'}>
                  <input
                    checked={this._sourceMode === 'notebook'}
                    name="nitro-source-mode"
                    onChange={() => {
                      this._sourceMode = 'notebook';
                      this.update();
                    }}
                    type="radio"
                  />
                  <span>
                    <span className="jp-NitroJudgeSourceOptionTitle">Current notebook</span>
                    <span className="jp-NitroJudgeSourceOptionDetail">Export code cells as a temporary Python file.</span>
                  </span>
                </label>
                <label className="jp-NitroJudgeSourceOption" data-selected={this._sourceMode === 'file'}>
                  <input
                    checked={this._sourceMode === 'file'}
                    name="nitro-source-mode"
                    onChange={() => {
                      this._sourceMode = 'file';
                      this.update();
                    }}
                    type="radio"
                  />
                  <span>
                    <span className="jp-NitroJudgeSourceOptionTitle">Python source file</span>
                    <span className="jp-NitroJudgeSourceOptionDetail">Pick an existing `.py` file from the notebook folder tree.</span>
                  </span>
                </label>
              </div>
            </fieldset>

            <label className="jp-NitroJudgeFieldLabel">
              <span className="jp-NitroJudgeFieldTitle">Source file</span>
              {this._sourceMode === 'file' ? (
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
              ) : (
                <p className="jp-NitroJudgeMuted jp-NitroJudgeSourceHint">
                  The current notebook will be exported from code cells into a temporary Python file.
                </p>
              )}
            </label>

            <label className="jp-NitroJudgeFieldLabel">
              <span className="jp-NitroJudgeFieldTitle">Note</span>
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
            <button
              disabled={this._busy || !this._status.loggedIn}
              onClick={() => void this._loadContests({ force: true })}
              type="button"
            >
              Refresh contests
            </button>
          </div>
        </section>

        {this._result ? (
          <section>
            <div className="jp-NitroJudgeSectionHeader">
              <h3>Feedback</h3>
            </div>
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

            <h3 className="jp-NitroJudgeSubheading">Subtasks</h3>
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

        {pickerState ? (
          <div className="jp-NitroJudgeOverlay" role="dialog" aria-modal="true" aria-label={pickerState.title}>
            <div className="jp-NitroJudgeOverlayCard">
              <div className="jp-NitroJudgeOverlayHeader">
                <h3>{pickerState.title}</h3>
                <button onClick={() => this._closePicker()} type="button">
                  Close
                </button>
              </div>
              <p className="jp-NitroJudgeMuted">Current path: {pickerState.currentPath || '/'}</p>
              {pickerState.error ? (
                <div className="jp-NitroJudgeMessage" data-kind="error">
                  {pickerState.error}
                </div>
              ) : null}
              {pickerState.loading ? (
                <div className="jp-NitroJudgeMessage" data-kind="info">
                  Loading files...
                </div>
              ) : null}
              <div className="jp-NitroJudgePickerList">
                {pickerState.currentPath ? (
                  <button className="jp-NitroJudgePickerItem jp-NitroJudgePickerNav" onClick={() => void this._goUpPicker()} type="button">
                    ../
                  </button>
                ) : null}
                {!pickerState.loading && pickerState.entries.length === 0 ? (
                  <p className="jp-NitroJudgeMuted">{pickerState.emptyMessage}</p>
                ) : null}
                {pickerState.entries.map(item => {
                  const isSelected = item.path === pickerState.selectedPath;
                  return (
                    <button
                      key={item.path}
                      className="jp-NitroJudgePickerItem"
                      data-selected={isSelected}
                      onClick={() => void this._handlePickerItem(item)}
                      type="button"
                    >
                      {item.type === 'directory' ? `${item.name}/` : item.name}
                    </button>
                  );
                })}
              </div>
              <div className="jp-NitroJudgeActions">
                <button onClick={() => this._closePicker()} type="button">
                  Close
                </button>
                <button
                  disabled={pickerState.loading || pickerState.selectedType !== 'file'}
                  onClick={() => this._confirmPicker()}
                  type="button"
                >
                  Select
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  private _canSubmit(): boolean {
    if (
      !this._status.loggedIn ||
      !this._selectedContest ||
      !this._selectedContest.hasStarted ||
      !this._selectedTask ||
      !this._outputPath
    ) {
      return false;
    }
    if (!this._outputPath.toLowerCase().endsWith('.csv')) {
      return false;
    }
    if (this._sourceMode === 'file' && !this._sourcePath) {
      return false;
    }
    if (this._sourceMode === 'file' && !this._sourcePath.toLowerCase().endsWith('.py')) {
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
      await this._loadContests({ force: true });
    } catch (error) {
      this._error = this._asMessage(error);
    } finally {
      this._clearBusy();
    }
  }

  private async _loadContests(options: { force?: boolean } = {}): Promise<void> {
    if (!options.force && contestCache) {
      this._contests = contestCache;
      if (this._selectedContest) {
        const refreshed = this._contests.find(
          item => item.org === this._selectedContest?.org && item.slug === this._selectedContest?.slug
        );
        this._selectedContest = refreshed ?? null;
        if (this._selectedContest) {
          await this._selectContest(`${this._selectedContest.org}/${this._selectedContest.slug}`);
          return;
        }
      }
      this.update();
      return;
    }

    await this._setBusy('Loading contests...');
    this._error = null;

    try {
      const response = await requestAPI<{ items: Contest[] }>('contests');
      this._contests = response.items;
      contestCache = response.items;
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

    if (!selected.hasStarted) {
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
      const selected = await this._openPicker('Pick output CSV', {
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
      const selected = await this._openPicker('Pick source file', {
        acceptFile: item => item.name.toLowerCase().endsWith('.py'),
        emptyMessage: 'No Python files in this folder. You can still open another folder or go up.'
      });
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

  private async _openPicker(title: string, options: FilePickerOptions = {}): Promise<string | null> {
    if (this._pickerResolver) {
      this._pickerResolver(null);
    }

    const promise = new Promise<string | null>(resolve => {
      this._pickerResolver = resolve;
    });

    this._pickerState = {
      acceptFile: options.acceptFile,
      currentPath: notebookDirectory(this._panel),
      emptyMessage: options.emptyMessage ?? 'No matching files in this folder.',
      entries: [],
      error: null,
      loading: true,
      selectedPath: null,
      selectedType: null,
      title
    };
    this.update();
    await this._loadPickerDirectory(this._pickerState.currentPath);
    return promise;
  }

  private async _loadPickerDirectory(path: string): Promise<void> {
    if (!this._pickerState) {
      return;
    }

    this._pickerState = {
      ...this._pickerState,
      currentPath: path,
      error: null,
      loading: true,
      selectedPath: null,
      selectedType: null
    };
    this.update();

    try {
      const model = await this._app.serviceManager.contents.get(path, { content: true });
      if (model.type !== 'directory') {
        throw new Error(`Path is not a directory: ${path}`);
      }

      const entries = ((model.content as Contents.IModel[]) ?? [])
        .filter(item => item.type === 'directory' || !this._pickerState?.acceptFile || this._pickerState.acceptFile(item))
        .map(item => ({ name: item.name, path: item.path, type: item.type }))
        .sort((a, b) => {
          if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });

      if (!this._pickerState) {
        return;
      }

      this._pickerState = {
        ...this._pickerState,
        currentPath: path,
        entries,
        loading: false
      };
    } catch (error) {
      if (!this._pickerState) {
        return;
      }

      this._pickerState = {
        ...this._pickerState,
        currentPath: path,
        entries: [],
        error: this._asMessage(error),
        loading: false
      };
    }

    this.update();
  }

  private async _handlePickerItem(item: PickerEntry): Promise<void> {
    if (!this._pickerState) {
      return;
    }

    if (item.type === 'directory') {
      await this._loadPickerDirectory(item.path);
      return;
    }

    this._pickerState = {
      ...this._pickerState,
      selectedPath: item.path,
      selectedType: item.type
    };
    this.update();
  }

  private async _goUpPicker(): Promise<void> {
    if (!this._pickerState || !this._pickerState.currentPath) {
      return;
    }

    const parentPath = PathExt.dirname(this._pickerState.currentPath);
    await this._loadPickerDirectory(parentPath === '.' ? '' : parentPath);
  }

  private _confirmPicker(): void {
    if (!this._pickerState || this._pickerState.selectedType !== 'file' || !this._pickerState.selectedPath) {
      return;
    }

    const selectedPath = this._pickerState.selectedPath;
    const resolve = this._pickerResolver;
    this._pickerState = null;
    this._pickerResolver = null;
    this.update();
    resolve?.(selectedPath);
  }

  private _closePicker(): void {
    const resolve = this._pickerResolver;
    this._pickerState = null;
    this._pickerResolver = null;
    this.update();
    resolve?.(null);
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
  private _pickerResolver: ((value: string | null) => void) | null = null;
  private _pickerState: PickerState | null = null;
  private _result: SubmissionResult | null = null;
}

function createJudgePanel(app: JupyterFrontEnd, notebook: NotebookPanel): MainAreaWidget<NitroJudgeBody> {
  const content = new NitroJudgeBody(app, notebook);
  const widget = new MainAreaWidget({ content });
  widget.id = `nitro-ai-judge:${notebook.id}:${Date.now()}`;
  widget.title.label = `Nitro AI Judge: ${PathExt.basename(notebook.context.path)}`;
  widget.title.closable = true;
  return widget;
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
            const widget = createJudgePanel(app, notebook);
            app.shell.add(widget, 'main');
            app.shell.activateById(widget.id);
          },
          tooltip: 'Open Nitro AI Judge submission tab'
        })
      );
    });
  }
};

export default plugin;
